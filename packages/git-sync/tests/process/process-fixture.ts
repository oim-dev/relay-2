import { expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GitSyncResponse } from "@relay/contracts";
import {
  initializeProject,
  nativeExecutableName,
  type RuntimeOptions,
} from "@relay/project-runtime";
import { decodeResponse } from "../../src/app/protocol";
import { withGitFixture } from "../integration/helpers/git-fixture";
import type {
  ProcessFixture,
  ProcessProjectContext,
  StartedSyncRequest,
} from "./process-fixture.types";
import { waitUntil } from "../../src/sync/engine";

/**
 * Читает ограниченный тестовый поток одновременно с выполнением процесса CLI.
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
        throw new Error("Ответ CLI превысил бюджет процессной fixture");
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
 * Запускает один private запрос к готовому relay и сразу читает оба потока.
 * Не декодирует ответ: аварийный выход CLI и смерть owner должны оставаться наблюдаемыми.
 * Окружение Git/HOME изолировано от пользователя; явные env позволяют тесту задать transport barrier.
 */
export function startSyncRequest(
  binary: string,
  options: RuntimeOptions,
  action: string,
  input: Record<string, unknown> = {},
  env: Record<string, string> = {},
): StartedSyncRequest {
  const home = options.home ?? options.cwd;
  const source = JSON.stringify({ version: 1, action, options, input });
  const child = Bun.spawn([binary, "--git-sync-request"], {
    cwd: options.cwd,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      RELAY_HOME: home,
      GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      ...env,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(source);
  child.stdin.end();
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  const outcome = Promise.all([
    processOutput(child.stdout),
    processOutput(child.stderr),
    child.exited,
  ])
    .then(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode }))
    .finally(() => clearTimeout(timer));
  return { child, outcome };
}

/**
 * Владеет изолированными проектами и bare remote; постоянных процессов нет.
 * Caller дожидается всех запросов до удаления данных. CLI собирается графом Turbo до process suite.
 */
export async function withProcessFixture(
  operation: (fixture: ProcessFixture) => Promise<void>,
): Promise<void> {
  await withGitFixture(async ({ root, remote }) => {
    const binary = fileURLToPath(
      new URL(`../../../../apps/cli/dist/${nativeExecutableName("relay")}`, import.meta.url),
    );
    await operation({
      root,
      remote,
      binary,
      /**
       * Отделяет кодовый каталог от RELAY_HOME, чтобы restore не зависел от checkout Git.
       */
      context(name, initialize = true): ProcessProjectContext {
        const cwd = join(root, name, "code");
        const home = join(root, name, "home");
        mkdirSync(cwd, { recursive: true });
        mkdirSync(home, { recursive: true });
        writeFileSync(join(home, "gitconfig"), "");
        const options = { cwd, home };
        return {
          options,
          location: initialize ? initializeProject({ ...options, name: "test-project" }) : null,
        };
      },
      /**
       * Проверяет потоки процесса независимо от успешности предметного действия.
       */
      async request(options, action, input = {}, env): Promise<GitSyncResponse> {
        const { child, outcome } = startSyncRequest(binary, options, action, input, env);
        try {
          const { stdout, stderr, exitCode } = await outcome;
          expect(stderr).toBe("");
          const response = decodeResponse(JSON.parse(stdout));
          expect(exitCode).toBe(response.ok ? 0 : response.error.exitCode);
          return response;
        } finally {
          if (child.exitCode === null) {
            child.kill("SIGKILL");
          }
          await child.exited;
        }
      },
    });
  });
}
