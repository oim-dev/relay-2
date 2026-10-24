import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { RelayError } from "@relay/contracts";
import { controlRequest, readEndpoint, responsive } from "../../src/local/control";
import { runSupervisor } from "../../src/worker/supervisor";
import { recordSupervisorFailure } from "../../src/worker/supervisor-failure";
import { eventually } from "../process/process-fixture";

const SECRET = "SECRET /private/path?token=credential; capability=private-token";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/**
 * Даёт отдельный физический home без Git и БД проекта; callback закрывает control owners до удаления.
 */
async function withSupervisorHome(
  operation: (home: string) => void | Promise<void>,
): Promise<void> {
  const artifacts = resolve(
    import.meta.dir,
    "../../../../.artifacts",
    new Date().toISOString().slice(0, 10),
    "git-sync-implementation/finalization/process-start-ci/startup-record/fixtures",
  );
  mkdirSync(artifacts, { recursive: true });
  const home = realpathSync(mkdtempSync(join(artifacts, "supervisor-")));
  try {
    await operation(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("Ограниченная запись fatal-исхода supervisor", () => {
  for (const full of [false, true]) {
    test(`занятый control mutex сохраняет исходную ошибку и живого owner при ${full ? "заполненных" : "свободных"} слотах`, async () => {
      await withSupervisorHome(async (home) => {
        const directory = join(home, "git-sync");
        const endpointPath = join(directory, "supervisor.json");
        const shutdown = new AbortController();
        const completion = runSupervisor(home, shutdown).then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        const failures: unknown[] = [];
        try {
          await eventually(async () => {
            const endpoint = readEndpoint(endpointPath);
            return endpoint !== null && (await responsive(endpoint));
          }, 2000);
          const owner = readEndpoint(endpointPath);
          if (!owner) {
            throw new Error("Живой supervisor должен сохранить endpoint");
          }
          const endpointBytes = readFileSync(endpointPath);
          if (full) {
            for (let slot = 0; slot < 16; slot++) {
              writeFileSync(
                join(directory, `supervisor-failure-${String(slot).padStart(2, "0")}.json`),
                `foreign-${slot}`,
              );
            }
          }

          await expect(runSupervisor(home, new AbortController())).rejects.toMatchObject({
            code: "GIT_SYNC_WORKER_BUSY",
            exitCode: 4,
            cause: {
              code: "LOCAL_LOCK_BUSY",
              exitCode: 4,
              cause: { code: "SQLITE_BUSY", errno: 5 },
            },
          });

          expect(readFileSync(endpointPath)).toEqual(endpointBytes);
          expect(await responsive(owner)).toBe(true);
          expect(await controlRequest(owner, "status")).toEqual({
            version: 1,
            ok: true,
            data: { projects: [], activeNetwork: 0, waitingNetwork: 0, maximumNetwork: 4 },
          });
          if (full) {
            for (let slot = 0; slot < 16; slot++) {
              expect(
                readFileSync(
                  join(directory, `supervisor-failure-${String(slot).padStart(2, "0")}.json`),
                  "utf8",
                ),
              ).toBe(`foreign-${slot}`);
            }
          } else {
            const path = join(directory, "supervisor-failure-00.json");
            const text = readFileSync(path, "utf8");
            const record: unknown = JSON.parse(text);
            expect(record).toEqual({
              version: 1,
              kind: "supervisor-failure",
              attemptId: expect.stringMatching(UUID_PATTERN),
              pid: process.pid,
              observedAt: expect.stringMatching(TIME_PATTERN),
              causes: [
                { code: "GIT_SYNC_WORKER_BUSY", exitCode: 4, errno: null, win32Code: null },
                { code: "LOCAL_LOCK_BUSY", exitCode: 4, errno: null, win32Code: null },
                { code: "SQLITE_BUSY", exitCode: null, errno: 5, win32Code: null },
              ],
            });
            expect(text).not.toContain(home);
            expect(text).not.toContain(owner.capability);
            expect(statSync(path).size).toBeLessThanOrEqual(8192);
            if (process.platform !== "win32") {
              expect(statSync(path).mode & 0o777).toBe(0o600);
            }
          }
        } catch (error) {
          failures.push(error);
        } finally {
          shutdown.abort();
          const outcome = await completion;
          if (!outcome.ok) {
            failures.push(outcome.error);
          }
        }
        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            "Проверка или завершение source supervisor не удались",
          );
        }
        expect(readEndpoint(endpointPath)).toBeNull();
        expect(
          readdirSync(directory).filter((name) => name.startsWith("supervisor-failure-")),
        ).toHaveLength(full ? 16 : 1);
      });
    });
  }

  test("глубокая цепочка сохраняет шесть технических причин без секретных текстов и payload", async () => {
    await withSupervisorHome((home) => {
      const directory = join(home, "git-sync");
      mkdirSync(directory);
      let cause: unknown;
      for (let index = 8; index >= 0; index--) {
        cause = Object.assign(new Error(SECRET.repeat(1024), { cause }), {
          code: `NATIVE_${index}`,
          errno: -100 - index,
          win32Code: 1000 + index,
          details: { path: SECRET, env: SECRET, capability: SECRET },
          stack: SECRET,
        });
      }
      const error = new RelayError("SUPERVISOR_TEST_FAILURE", SECRET, 4, { path: SECRET });
      error.cause = cause;

      recordSupervisorFailure(home, error);

      const path = join(directory, "supervisor-failure-00.json");
      const text = readFileSync(path, "utf8");
      const record: unknown = JSON.parse(text);
      expect(record).toEqual({
        version: 1,
        kind: "supervisor-failure",
        attemptId: expect.stringMatching(UUID_PATTERN),
        pid: process.pid,
        observedAt: expect.stringMatching(TIME_PATTERN),
        causes: [
          { code: "SUPERVISOR_TEST_FAILURE", exitCode: 4, errno: null, win32Code: null },
          { code: "NATIVE_0", exitCode: null, errno: -100, win32Code: 1000 },
          { code: "NATIVE_1", exitCode: null, errno: -101, win32Code: 1001 },
          { code: "NATIVE_2", exitCode: null, errno: -102, win32Code: 1002 },
          { code: "NATIVE_3", exitCode: null, errno: -103, win32Code: 1003 },
          { code: "NATIVE_4", exitCode: null, errno: -104, win32Code: 1004 },
        ],
      });
      expect(text).not.toContain("SECRET");
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8192);
      expect(error.cause).toBe(cause);
      expect(error.message).toBe(SECRET);
    });
  });

  test("циклическая cause и небезопасные коды не превращаются в dump и недопустимые числа", async () => {
    await withSupervisorHome((home) => {
      const directory = join(home, "git-sync");
      mkdirSync(directory);
      const error = Object.assign(new RelayError(SECRET, SECRET, Number.MAX_SAFE_INTEGER + 1), {
        errno: 1.5,
        win32Code: Number.POSITIVE_INFINITY,
      });
      error.cause = error;

      recordSupervisorFailure(home, error);

      const text = readFileSync(join(directory, "supervisor-failure-00.json"), "utf8");
      const record: unknown = JSON.parse(text);
      expect(record).toMatchObject({
        causes: [{ code: null, exitCode: null, errno: null, win32Code: null }],
      });
      expect(text).not.toContain("SECRET");
      expect(error.cause).toBe(error);
    });
  });

  test("повреждённый, oversized и symlink слоты сохраняются, после 16 слотов новые файлы не появляются", async () => {
    await withSupervisorHome((home) => {
      const directory = join(home, "git-sync");
      const foreign = join(home, "foreign");
      mkdirSync(directory);
      mkdirSync(foreign);
      writeFileSync(join(foreign, "marker"), SECRET);
      const malformed = join(directory, "supervisor-failure-00.json");
      const oversized = join(directory, "supervisor-failure-01.json");
      const link = join(directory, "supervisor-failure-02.json");
      writeFileSync(malformed, "{foreign malformed JSON");
      const oversizedBytes = Buffer.alloc(9000, "x");
      writeFileSync(oversized, oversizedBytes);
      symlinkSync(foreign, link, process.platform === "win32" ? "junction" : "dir");
      const error = new RelayError("SUPERVISOR_TEST_FAILURE", SECRET, 4);

      // 13 свободных слотов, затем ещё один fatal-исход при полностью занятом namespace.
      for (let attempt = 0; attempt < 13; attempt++) {
        recordSupervisorFailure(home, error);
      }
      const records = Array.from({ length: 13 }, (_, index) =>
        readFileSync(
          join(directory, `supervisor-failure-${String(index + 3).padStart(2, "0")}.json`),
          "utf8",
        ),
      );
      recordSupervisorFailure(home, error);

      expect(readFileSync(malformed, "utf8")).toBe("{foreign malformed JSON");
      expect(readFileSync(oversized)).toEqual(oversizedBytes);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(realpathSync(link)).toBe(realpathSync(foreign));
      expect(readdirSync(foreign)).toEqual(["marker"]);
      expect(readFileSync(join(foreign, "marker"), "utf8")).toBe(SECRET);
      expect(readdirSync(directory).sort()).toEqual(
        Array.from(
          { length: 16 },
          (_, slot) => `supervisor-failure-${String(slot).padStart(2, "0")}.json`,
        ),
      );
      for (const [index, record] of records.entries()) {
        const slot = index + 3;
        const path = join(directory, `supervisor-failure-${String(slot).padStart(2, "0")}.json`);
        expect(statSync(path).size).toBeLessThanOrEqual(8192);
        expect(readFileSync(path, "utf8")).toBe(record);
      }
      expect(new Set(records).size).toBe(13);
    });
  });

  test("symlink git-sync не позволяет диагностике писать в чужой каталог", async () => {
    await withSupervisorHome((home) => {
      const foreign = join(home, "foreign");
      mkdirSync(foreign);
      symlinkSync(
        foreign,
        join(home, "git-sync"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const error = new RelayError("SUPERVISOR_TEST_FAILURE", SECRET, 4);

      expect(() => recordSupervisorFailure(home, error)).not.toThrow();

      expect(readdirSync(foreign)).toEqual([]);
      expect(lstatSync(join(home, "git-sync")).isSymbolicLink()).toBe(true);
    });
  });

  test("недоступный namespace диагностики не создаётся и не заменяет исходную ошибку", async () => {
    await withSupervisorHome((home) => {
      const error = new RelayError("SUPERVISOR_TEST_FAILURE", SECRET, 4);

      expect(() => recordSupervisorFailure(home, error)).not.toThrow();

      expect(existsSync(join(home, "git-sync"))).toBe(false);
      expect(error).toMatchObject({
        code: "SUPERVISOR_TEST_FAILURE",
        message: SECRET,
        exitCode: 4,
      });
    });
  });
});
