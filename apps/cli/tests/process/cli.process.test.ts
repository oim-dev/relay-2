import { describe, expect, test } from "bun:test";
import { version } from "../../package.json";
import { invokeBinary } from "./cli-process";

const nestedHelp = [
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
      const result = await invokeBinary([...command, "--help"]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("ИСПОЛЬЗОВАНИЕ:");
      expect(result.files).toEqual([]);
    },
  );

  test("неизвестное вложенное действие не открывает и не создаёт проект", async () => {
    const result = await invokeBinary(["document", "missing"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toBe("");
    expect(result.stderr).toContain("INVALID_ARGUMENT");
    expect(result.files).toEqual([]);
  });

  test("закрытый получателем stdout завершает бинарник без необработанной ошибки pipe", async () => {
    const result = await invokeBinary(["--help"], { closeStdout: true });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.files).toEqual([]);
  });
});
