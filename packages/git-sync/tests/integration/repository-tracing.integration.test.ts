import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withGitRepository } from "./helpers/git-repository-fixture";
import { DataRepository } from "../../src/transport/repository";
import * as commands from "../../src/transport/git";
import type { ProcessResult } from "../../src/transport/process.types";

const stderrTraces = ["GIT_TRACE", "GIT_TRACE2", "GIT_TRACE2_EVENT", "GIT_TRACE2_PERF"] as const;
const traceIsolation = {
  GIT_TRACE: undefined,
  GIT_TRACE_SETUP: undefined,
  GIT_TRACE_PACKET: undefined,
  GIT_TRACE_PACK_ACCESS: undefined,
  GIT_TRACE_PERFORMANCE: undefined,
  GIT_TRACE2: undefined,
  GIT_TRACE2_EVENT: undefined,
  GIT_TRACE2_PERF: undefined,
};

/**
 * Читает три cold refs одновременно, проверяя общий in-flight запрос и точные роли курсоров.
 */
function readRefs(repository: DataRepository): Promise<(string | null)[]> {
  return Promise.all([
    repository.ref("refs/heads/data"),
    repository.ref("refs/relay/remote"),
    repository.acceptedCommit(),
  ]);
}

describe("Git tracing и повреждение служебных refs", () => {
  test.each(stderrTraces)(
    "%s в stderr не меняет cold refs и число реальных Git-запросов",
    async (variable) => {
      await withGitRepository(async (repository, _root, env) => {
        const base = await repository.commit(new Map([["record.json", Buffer.from("{}")]]), null);
        await repository.accepted(base);
        const traced = new DataRepository({
          ...repository.options,
          env: { ...env, ...traceIsolation, [variable]: "1" },
        });
        const actualGit = commands.git;
        const responses: ProcessResult[] = [];
        const invocation = spyOn(commands, "git").mockImplementation(async (...args) => {
          const response = await actualGit(...args);
          responses.push(response);
          return response;
        });
        try {
          expect(await readRefs(traced)).toEqual([base, base, base]);
          expect(invocation).toHaveBeenCalledTimes(1);
          expect(responses[0]?.exitCode).toBe(0);
          expect(responses[0]?.stderr.length).toBeGreaterThan(0);
          expect(invocation.mock.calls[0]?.[2]?.env?.[variable]).toBe("1");
        } finally {
          invocation.mockRestore();
        }
      });
    },
    15_000,
  );

  test("trace-файлы сохраняют диагностический и машинный вывод единственного cold запроса", async () => {
    await withGitRepository(async (repository, root, env) => {
      const diagnostic = join(root, "git.trace");
      const events = join(root, "git-events.jsonl");
      const traced = new DataRepository({
        ...repository.options,
        env: { ...env, ...traceIsolation, GIT_TRACE: diagnostic, GIT_TRACE2_EVENT: events },
      });
      const invocation = spyOn(commands, "git");
      try {
        expect(await readRefs(traced)).toEqual([null, null, null]);
        expect(invocation).toHaveBeenCalledTimes(1);
        expect(readFileSync(diagnostic, "utf8").length).toBeGreaterThan(0);
        const trace = readFileSync(events, "utf8")
          .trim()
          .split("\n")
          .map((line: string): unknown => JSON.parse(line));
        expect(
          trace.filter(
            (event) =>
              typeof event === "object" &&
              event !== null &&
              "event" in event &&
              event.event === "start",
          ),
        ).toHaveLength(1);
        expect(trace).toContainEqual(expect.objectContaining({ event: "exit", code: 1 }));
        expect(invocation.mock.calls[0]?.[2]?.env?.GIT_TRACE).toBe(diagnostic);
        expect(invocation.mock.calls[0]?.[2]?.env?.GIT_TRACE2_EVENT).toBe(events);
      } finally {
        invocation.mockRestore();
      }
    });
  }, 15_000);

  test.each([
    { name: "неверное содержимое ref", value: "not-an-object-id\n" },
    { name: "OID отсутствующего объекта", value: "1234567890123456789012345678901234567890\n" },
  ])(
    "$name отклоняется при trace, а repair тем же owner перечитывает весь набор",
    async ({ value }) => {
      await withGitRepository(async (repository, _root, env) => {
        const base = await repository.commit(new Map([["record.json", Buffer.from("{}")]]), null);
        await repository.accepted(base);
        const remotePath = join(repository.options.directory, "refs/relay/remote");
        const original = readFileSync(remotePath);
        const traced = new DataRepository({
          ...repository.options,
          env: { ...env, ...traceIsolation, GIT_TRACE: "1", GIT_TRACE2_EVENT: "1" },
        });
        writeFileSync(remotePath, value);

        await expect(traced.acceptedCommit()).rejects.toMatchObject({
          code: "GIT_INVALID_REPOSITORY",
          details: { operation: "read-state-refs", exitCode: 128, reason: expect.any(String) },
        });
        expect(readFileSync(remotePath, "utf8")).toBe(value);
        expect(readFileSync(join(repository.options.directory, "refs/heads/data"), "utf8")).toBe(
          `${base}\n`,
        );
        expect(
          readFileSync(join(repository.options.directory, "refs/relay/accepted"), "utf8"),
        ).toBe(`${base}\n`);

        writeFileSync(remotePath, original);
        const next = await repository.commit(
          new Map([["record.json", Buffer.from('{"next":true}')]]),
          base,
        );
        await repository.accepted(next);
        const invocation = spyOn(commands, "git");
        try {
          expect(await readRefs(traced)).toEqual([next, next, next]);
          expect(invocation).toHaveBeenCalledTimes(1);
          expect(invocation.mock.calls[0]?.[2]?.env?.GIT_TRACE).toBe("1");
        } finally {
          invocation.mockRestore();
        }
      });
    },
    15_000,
  );
});
