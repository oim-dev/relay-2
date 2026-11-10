import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  discoverGitSyncBinary,
  nativeExecutableName,
  type ProcessResult,
} from "@relay/project-runtime";
import { RuntimeFixture } from "./helpers/runtime-fixture";

const siblingCases = [
  {
    name: "совместимый sibling предпочтительнее PATH",
    version: "relay 0.0.0",
    selected: "sibling",
  },
  {
    name: "несовместимый sibling уступает совместимому PATH",
    version: "relay 9.0.0",
    selected: "path",
  },
] as const;
const missingOverrides = [
  { name: "отсутствующий файл", binary: "missing-relay" },
  { name: "пустой override", binary: "  " },
] as const;
let fixture: RuntimeFixture;

/**
 * Создаёт лишь executable-кандидат discovery, не исполняемый тестом: version boundary подменён runner.
 */
function createCliCandidate(directory: string): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, nativeExecutableName("relay"));
  writeFileSync(path, "fixture");
  chmodSync(path, 0o700);
  return path;
}

beforeEach(() => {
  fixture = new RuntimeFixture("project-local-sync/cli-port-review");
});
afterEach(async () => {
  await fixture.dispose();
});

describe("Выбор совместимой CLI для process request", () => {
  test.each(siblingCases)("$name", async ({ version, selected }) => {
    const sibling = createCliCandidate(join(fixture.root, "sibling"));
    const path = createCliCandidate(join(fixture.root, "path"));
    const calls: string[] = [];

    const binary = await discoverGitSyncBinary({
      cwd: fixture.cwd,
      env: { [process.platform === "win32" ? "Path" : "PATH"]: join(fixture.root, "path") },
      executablePath: join(fixture.root, "sibling", nativeExecutableName("relay-server")),
      version: "0.0.0",
      userHome: fixture.root,
      /**
       * Подтверждает версию конкретного файла, не подменяя приоритет кандидатов алгоритмом теста.
       */
      async runner(command): Promise<ProcessResult> {
        calls.push(command.executable);
        expect(command.args).toEqual(["--version"]);
        expect(command.strictStdout).toBe(true);
        return {
          exitCode: 0,
          stderr: "",
          stdout: command.executable === sibling ? version : "relay 0.0.0",
        };
      },
    });

    expect(binary).toBe(selected === "sibling" ? sibling : path);
    expect(calls).toEqual(selected === "sibling" ? [sibling] : [sibling, path]);
  });

  test.each(missingOverrides)("$name не обходится доступной CLI из PATH", async ({ binary }) => {
    createCliCandidate(join(fixture.root, "path"));
    let calls = 0;

    await expect(
      discoverGitSyncBinary({
        cwd: fixture.cwd,
        env: { [process.platform === "win32" ? "Path" : "PATH"]: join(fixture.root, "path") },
        binary,
        executablePath: process.execPath,
        version: "0.0.0",
        userHome: fixture.root,
        /**
         * Любой probe означал бы запрещённый fallback после явного ошибочного выбора.
         */
        async runner(): Promise<ProcessResult> {
          calls++;
          return { exitCode: 0, stdout: "relay 0.0.0", stderr: "" };
        },
      }),
    ).rejects.toMatchObject({
      code: "GIT_SYNC_BINARY_NOT_FOUND",
      exitCode: 3,
      message: expect.stringContaining("RELAY_CLI_BIN"),
    });

    expect(calls).toBe(0);
  });

  test("прежний relay-git-sync того же выпуска не принимается за CLI", async () => {
    const binary = createCliCandidate(join(fixture.root, "override"));
    let calls = 0;

    await expect(
      discoverGitSyncBinary({
        cwd: fixture.cwd,
        env: {},
        binary,
        executablePath: process.execPath,
        version: "0.0.0",
        userHome: fixture.root,
        /**
         * Версия выпуска совпадает, но компонент сообщает отменённую идентичность executable.
         */
        async runner(): Promise<ProcessResult> {
          calls++;
          return { exitCode: 0, stdout: "relay-git-sync 0.0.0", stderr: "" };
        },
      }),
    ).rejects.toMatchObject({ code: "GIT_SYNC_VERSION_MISMATCH", exitCode: 4 });

    expect(calls).toBe(1);
  });
});
