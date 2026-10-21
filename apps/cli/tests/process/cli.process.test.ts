import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { version } from "../../package.json";
import type { BinaryOptions, BinaryResult } from "./cli-process.types";

const binary = resolve(import.meta.dir, "../../dist/relay");
const artifacts = resolve(
  import.meta.dir,
  "../../../../.artifacts",
  new Date().toISOString().slice(0, 10),
);
const nestedHelp = [
  { name: "создание документа", command: ["document", "create"] },
  { name: "добавление критерия", command: ["task", "criterion", "add"] },
  { name: "регистрация проекта", command: ["workspace", "project", "add"] },
  { name: "создание этапа", command: ["plan", "stage", "create"] },
  { name: "запуск сессии", command: ["session", "start"] },
] as const;

/**
 * Запускает поставляемый бинарник с изолированными HOME и cwd, читая реальные потоки.
 * Процесс ограничен тремя секундами; finally завершает его и удаляет каталог.
 * При closeStdout закрывается настоящая принимающая сторона pipe, а не заглушка записи.
 */
async function invokeBinary(
  argv: readonly string[],
  options: BinaryOptions = {},
): Promise<BinaryResult> {
  await mkdir(artifacts, { recursive: true });
  const directory = await mkdtemp(join(artifacts, "cli-process-"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const process = Bun.spawn([binary, ...argv], {
      cwd: directory,
      env: { HOME: directory, RELAY_HOME: directory },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 3000,
    });
    child = process;
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      options.closeStdout
        ? process.stdout.cancel().then(() => "")
        : new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    return { exitCode, stdout, stderr, files: await readdir(directory) };
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await child.exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

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
