import { describe, expect, test } from "bun:test";
import { checkConcurrency } from "./check-options";
import { checkCommand } from "./check-command";
import { repository } from "./catalog";

describe("Обязательный полный локальный check", () => {
  test.each([
    { name: "по умолчанию", args: [], expected: 4 },
    { name: "нижняя граница через знак равенства", args: ["--concurrency=1"], expected: 1 },
    { name: "верхняя граница отдельным аргументом", args: ["--concurrency", "32"], expected: 32 },
  ])("$name: лимит параллельности сохраняется", ({ args, expected }) => {
    const concurrency = checkConcurrency(args);

    expect(concurrency).toBe(expected);
  });

  test("Turbo сохраняет зависимости успешной сборки и не запрашивает файловые отчёты", () => {
    const command = checkCommand(4);

    expect(command).toContain("--concurrency=4");
    expect(command).toContain("--continue=dependencies-successful");
    expect(command).not.toContain("--parallel");
    expect(command).not.toContain("--summarize");
    expect(command).not.toContain("--log-file");
  });

  test.each([
    { name: "фильтр компонента", args: ["--filter=cli"] },
    { name: "только затронутые компоненты", args: ["--affected"] },
    { name: "отдельный набор", args: ["test:unit"] },
    { name: "нулевой лимит", args: ["--concurrency=0"] },
    { name: "слишком большой лимит", args: ["--concurrency=33"] },
    { name: "дробный лимит", args: ["--concurrency=1.5"] },
    { name: "фильтр после допустимого лимита", args: ["--concurrency=4", "--filter=cli"] },
  ])("$name отклоняется без сокращения полного check", ({ args }) => {
    expect(() => checkConcurrency(args)).toThrow("все штатные проверки обязательны");
  });

  test("процессный вход отклоняет частичный check до запуска инструментов", () => {
    const result = Bun.spawnSync([process.execPath, "scripts/check.ts", "--filter=cli"], {
      cwd: repository,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("все штатные проверки обязательны");
    expect(result.stdout.toString()).toBe("");
  });
});
