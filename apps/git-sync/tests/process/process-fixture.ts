import { expect } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeProject, type RuntimeOptions } from "@relay/project-runtime";
import { decodeResponse } from "../../src/app/protocol";
import { withGitFixture } from "../integration/helpers/git-fixture";
import type { ProcessFixture } from "./process-fixture.types";
import { executeAction } from "../../src/app/actions";
import { waitUntil } from "../../src/sync/engine";

/**
 * Читает ограниченный тестовый поток одновременно с выполнением компонентного процесса.
 */
async function processOutput(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      size += result.value.length;
      if (size > 16 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("Component response exceeded fixture budget");
      }
      chunks.push(result.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}

/**
 * Ждёт наблюдаемое условие с общим deadline; не подменяет утверждение произвольной задержкой.
 */
export async function eventually(
  condition: () => Promise<boolean> | boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) {
      throw new Error("Условие процессного сценария не достигнуто до deadline");
    }
    await waitUntil(Date.now() + 50, AbortSignal.timeout(1000));
  }
}

/**
 * Закрывает запущенные тестом workers до удаления их баз и private repositories.
 * Сборка выполняется script владельца до запуска process suite.
 */
export async function withProcessFixture(
  operation: (fixture: ProcessFixture) => Promise<void>,
): Promise<void> {
  await withGitFixture(async ({ root, remote }) => {
    const binary = fileURLToPath(new URL("../../dist/relay-git-sync", import.meta.url));
    const contexts: RuntimeOptions[] = [];
    try {
      await operation({
        root,
        remote,
        binary,
        /**
         * Отделяет кодовый каталог от RELAY_HOME, чтобы restore не зависел от checkout Git.
         */
        context(name, initialize = true) {
          const cwd = join(root, name, "code");
          const home = join(root, name, "home");
          mkdirSync(cwd, { recursive: true });
          mkdirSync(home, { recursive: true });
          const options = { cwd, home };
          contexts.push(options);
          return {
            options,
            location: initialize ? initializeProject({ ...options, name: "test-project" }) : null,
          };
        },
        /**
         * Проверяет потоки процесса независимо от успешности предметного действия.
         */
        async request(options, action, input = {}, env) {
          // Прямой spawn проверяет request-протокол; persistent workers принадлежат отдельному S.
          // Их независимость от strict cleanup request job проверяет broker.process.test.ts.
          const child = Bun.spawn([binary, "--request"], {
            cwd: options.cwd,
            env: { ...process.env, ...env },
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
          });
          child.stdin.write(JSON.stringify({ version: 1, action, options, input }));
          child.stdin.end();
          const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
          try {
            const [stdout, stderr, exitCode] = await Promise.all([
              processOutput(child.stdout),
              processOutput(child.stderr),
              child.exited,
            ]);
            expect(stderr).toBe("");
            const response = decodeResponse(JSON.parse(stdout));
            expect(exitCode).toBe(response.ok ? 0 : response.error.exitCode);
            return response;
          } finally {
            clearTimeout(timer);
          }
        },
      });
    } finally {
      await Promise.allSettled(
        contexts.map((options) => executeAction({ version: 1, action: "worker.stop", options })),
      );
    }
  });
}
