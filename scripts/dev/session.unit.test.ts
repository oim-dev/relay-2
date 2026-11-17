import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { runDevelopmentSession } from "./session";

describe("Предварительная отмена dev-сессии", () => {
  test("уже отменённая сессия успешно завершается без существующего playground или checkout", async () => {
    // Каталог намеренно не создаётся: выбор проекта до проверки abort дал бы ошибку конфигурации.
    const directory = resolve(
      import.meta.dir,
      "../../.artifacts",
      new Date().toISOString().slice(0, 10),
      "dev-mode-test-review",
      `not-created-${crypto.randomUUID()}`,
    );
    const controller = new AbortController();
    controller.abort("SIGTERM");

    const result = await runDevelopmentSession(
      {
        runtime: { cwd: join(directory, "missing-project"), home: join(directory, "home") },
        port: 3210,
        webPort: 5174,
      },
      {
        repository: join(directory, "missing-checkout"),
        bun: process.execPath,
        env: { HOME: directory, USERPROFILE: directory, PATH: "" },
        signal: controller.signal,
      },
    );

    expect(result).toBeUndefined();
    expect(existsSync(directory)).toBe(false);
  });
});
