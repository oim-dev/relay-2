import { describe, expect, test } from "bun:test";
import { invokeIsolatedCli as invoke } from "../../tests/helpers/help";

const markdown = "- [ ] Проверить 'таймаут' 😀  \n\n    Сохранить отступ\n";
const checkpoint = [
  "checkpoint",
  "save",
  "CP-1",
  "--if-revision",
  "1",
  "--run",
  "run-id",
  "--title",
  "Материал",
  "--body",
  "Содержание",
] as const;
const textInputs = [
  { name: "список с кириллицей и emoji", text: markdown, suffix: [] },
  { name: "длинный многострочный список", text: markdown.repeat(100), suffix: [] },
  { name: "список вместе со справкой", text: markdown, suffix: ["--help"] },
  { name: "список вместе с версией", text: markdown, suffix: ["--version"] },
] as const;

describe("Диагностика dash-leading текста", () => {
  test.each(textInputs)(
    "$name даёт краткую причину и способ передать исходный текст",
    async ({ text, suffix }) => {
      const result = await invoke([...checkpoint, "--remaining", text, ...suffix]);

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("INVALID_ARGUMENT");
      expect(result.stderr).toContain("Не указано значение параметра '--remaining'");
      expect(result.stderr).toContain("Аргумент после --remaining начинается с «-»");
      expect(result.stderr).toContain("--remaining= с исходным текстом в shell-кавычках");
      expect(result.stderr).toContain("Справка: relay checkpoint save --help");
      expect(result.stderr.trim().split("\n")).toHaveLength(4);
      expect(result.stderr).not.toContain("Неизвестный параметр:");
      expect(result.stderr).not.toContain("таймаут");
      expect(result.stderr).not.toContain("�");
    },
  );

  test("группировка сохраняет отдельные неизвестные флаги, включая ту же букву", async () => {
    const result = await invoke([
      ...checkpoint,
      "-х",
      "--remaining",
      "- ххх",
      "--unknown",
      "-х",
      "--format=json",
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    const failure = JSON.parse(result.stderr);
    expect(failure).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENT", helpCommand: "relay checkpoint save --help" },
    });
    expect(failure.error.message.match(/Неизвестный параметр: -х/g)).toHaveLength(2);
    expect(failure.error.message).toContain("Неизвестный параметр: --unknown");
    expect(failure.error.message.match(/Аргумент после --remaining/g)).toHaveLength(1);
    expect(failure.error.message).toContain("--remaining=");
    expect(failure.error.message).not.toContain("Справка:");
  });

  test("отдельный неизвестный длинный флаг не считается Markdown-значением", async () => {
    const result = await invoke(["document", "create", "--body", "--unknown", "--help"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Неизвестный параметр: --unknown");
    expect(result.stderr).not.toContain("Аргумент после --body");
  });

  test("справка сохраняет нативный приоритет над отсутствующим значением без неизвестных флагов", async () => {
    const result = await invoke(["document", "create", "--body", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("ИСПОЛЬЗОВАНИЕ:");
  });
});
