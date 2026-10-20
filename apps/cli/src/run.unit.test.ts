import { describe, expect, test } from "bun:test";
import { version } from "../package.json";
import { runCli, type CliRuntime } from "./run";
import { createProgram } from "./program";
import type { Command } from "gunshi";

async function invoke(argv: readonly string[], runtime?: CliRuntime) {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(
    argv,
    {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    },
    runtime,
  );
  return { exitCode, stdout, stderr };
}

describe("CLI", () => {
  test("закрытый stdout завершается успешно, остальные ошибки записи сохраняют диагностику", async () => {
    for (const code of ["EPIPE", "EIO"]) {
      let stderr = "";
      const exit = await runCli(["--version"], {
        stdout: () => {
          throw Object.assign(new Error("запись не удалась"), { code });
        },
        stderr: (text) => {
          stderr += text;
        },
      });
      expect(exit).toBe(code === "EPIPE" ? 0 : 1);
      if (code === "EPIPE") expect(stderr).toBe("");
      else expect(stderr).toContain("запись не удалась");
    }
  });
  test("каждая зарегистрированная команда имеет справку без чтения проекта и stdin", async () => {
    const runtime: CliRuntime = {
      cwd: "/missing-relay-cli-test",
      env: { RELAY_CONFIG: "/missing-relay-config.json" },
      stdin: () => {
        throw new Error("Справка не должна читать stdin");
      },
    };
    const { options } = createProgram(runtime);
    const visit = async (commands: Map<string, Command>, path: string[] = []): Promise<void> => {
      for (const [name, command] of commands) {
        const route = [...path, name];
        const help = await invoke([...route, "--help"], runtime);
        expect(help.exitCode).toBe(0);
        expect(help.stderr).toBe("");
        expect(help.stdout).toContain("ИСПОЛЬЗОВАНИЕ:");
        if (command.subCommands instanceof Map) await visit(command.subCommands, route);
      }
    };
    await visit(options.subCommands);
  });
  test("пустой вызов и --help показывают одинаковую русскую справку", async () => {
    const help = await invoke(["--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toContain("ИСПОЛЬЗОВАНИЕ:");
    expect(help.stdout).toContain("Показать справку");
    expect(help.stdout).toContain("Показать версию");
    expect(await invoke([])).toEqual(help);
  });

  test("справка показывает фактические параметры без несуществующего каталога алиасов", async () => {
    const search = await invoke(["search", "--help"]);
    expect(search.stdout).toContain("предметным текстам");
    expect(search.stdout).toContain("--cursor");
    expect((await invoke(["inspect", "keys", "--help"])).exitCode).toBe(2);
    const checkpoint = await invoke(["checkpoint", "open", "--help"]);
    expect(checkpoint.stdout).toContain("runId");
    expect(checkpoint.stdout).not.toContain("--accept");
    const stage = await invoke(["plan", "stage", "create", "--help"]);
    expect(stage.stdout).toContain("--before");
  });

  test("параллельные вызовы изолируют результат, ошибку и состояние Gunshi", async () => {
    const [first, invalid, last] = await Promise.all([
      invoke(["--version"]),
      invoke(["--unknown"]),
      invoke(["-v"]),
    ]);
    expect(first).toEqual({ exitCode: 0, stdout: `${version}\n`, stderr: "" });
    expect(last).toEqual(first);
    expect(invalid.exitCode).toBe(2);
    expect(invalid.stdout).toBe("");
    expect(invalid.stderr).toContain("Неизвестный параметр: --unknown");
    expect(invalid.stderr.match(/Ошибка:/g)).toHaveLength(1);
  });

  test.each([
    { argv: ["--help", "--unknown"], message: "Неизвестный параметр: --unknown" },
    { argv: ["--version=unexpected"], message: "Недопустимое значение" },
    { argv: ["missing", "--help"], message: "Неизвестная команда: «missing»" },
    { argv: ["--", "missing"], message: "Неизвестная команда: «missing»" },
  ])("ошибочный ввод $argv направляется только в stderr", async ({ argv, message }) => {
    const result = await invoke(argv);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(message);
    expect(result.stderr).toContain("Справка: relay --help");
  });
});
