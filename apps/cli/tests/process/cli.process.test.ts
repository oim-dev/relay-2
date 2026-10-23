import { describe, expect, test } from "bun:test";
import { version } from "../../package.json";
import { invokeBinary } from "./cli-process";

const nestedHelp = [
  { name: "групповое чтение", command: ["get"] },
  { name: "пакет с открытым stdin", command: ["batch", "--input", "-"] },
  { name: "восстановление пакета", command: ["batch", "result"] },
  { name: "создание документа", command: ["document", "create"] },
  { name: "добавление критерия", command: ["task", "criterion", "add"] },
  { name: "регистрация проекта", command: ["workspace", "project", "add"] },
  { name: "создание этапа", command: ["plan", "stage", "create"] },
  { name: "запуск сессии", command: ["session", "start"] },
] as const;

describe("Поставляемый бинарник CLI", () => {
  test("вызов версии из пустого каталога возвращает встроенную версию без создания файлов", async () => {
    const result = await invokeBinary(["--version"]);

    expect(result).toEqual({
      exitCode: 0,
      stdout: `${version}\n`,
      stderr: "",
      files: [],
    });
  });

  test("бинарник направляет ошибку ввода в stderr и завершает процесс с кодом 2", async () => {
    const result = await invokeBinary(["--unknown"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Неизвестный параметр: --unknown");
    expect(result.stderr).toContain("INVALID_ARGUMENT");
    expect(result.files).toEqual([]);
  });

  test.each(nestedHelp)(
    "$name: вложенная справка доступна без проекта и обязательных аргументов",
    async ({ command }) => {
      const result = await invokeBinary([...command, "--help"], { openStdin: true });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("ИСПОЛЬЗОВАНИЕ:");
      expect(result.stdout).toContain("ПОДРОБНОСТИ:\n");
      expect(result.stdout).toContain("ПРИМЕРЫ:\n  # ");
      expect(result.files).toEqual([]);
    },
  );

  test("неизвестное вложенное действие не открывает и не создаёт проект", async () => {
    const result = await invokeBinary(["document", "missing"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toBe("");
    expect(result.stderr).toContain("INVALID_ARGUMENT");
    expect(result.stderr).toContain("Справка: relay document --help");
    expect(result.files).toEqual([]);
  });

  test("JSON-ошибка вложенной группы содержит отдельную исполнимую команду справки", async () => {
    const result = await invokeBinary(["application", "participation", "missing", "--format=json"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_ARGUMENT",
        helpCommand: "relay application participation --help",
      },
    });
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.files).toEqual([]);
  });

  test("закрытый получателем stdout завершает бинарник без необработанной ошибки pipe", async () => {
    const result = await invokeBinary(["--help"], { closeStdout: true });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.files).toEqual([]);
  });
});
