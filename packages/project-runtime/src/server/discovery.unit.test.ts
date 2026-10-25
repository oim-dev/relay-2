import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { discoverServerBinary } from "./discovery";
import type { ProcessCommand, ProcessResult } from "../git-sync/process.types";

describe("Совместимость отдельного relay-server", () => {
  test("несовместимый явный binary отклоняется без fallback на другой выпуск", async () => {
    const calls: ProcessCommand[] = [];

    const discovery = discoverServerBinary({
      cwd: import.meta.dir,
      env: { PATH: "/missing" },
      userHome: "/missing",
      executablePath: process.execPath,
      binary: process.execPath,
      version: "server-release",
      /**
       * Подменяет только автономный version subprocess, фиксируя exact executable/argv.
       */
      async runner(command): Promise<ProcessResult> {
        calls.push(command);
        return { exitCode: 0, stdout: "relay-server another-release\n", stderr: "" };
      },
    });

    await expect(discovery).rejects.toMatchObject({
      code: "SERVER_VERSION_MISMATCH",
      exitCode: 4,
      details: { expected: "server-release" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      executable: realpathSync(process.execPath),
      args: ["--version"],
      strictStdout: true,
    });
  });
});
