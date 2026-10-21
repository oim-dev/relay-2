import { describe, expect, test } from "bun:test";
import type { Command } from "gunshi";
import { version } from "../../package.json";
import type { CommandRoute, InvocationResult } from "../../tests/helpers/run-fixture.types";
import { runCli } from "./run";
import { createProgram } from "./program";
import type { CliRuntime } from "../execution/runtime.types";

const isolatedRuntime: CliRuntime = {
  cwd: "/missing-relay-cli-test",
  env: { RELAY_CONFIG: "/missing-relay-config.json" },
  /**
   * Делает ошибкой любое чтение stdin в справке и других командах без ввода.
   */
  stdin: (): never => {
    throw new Error("Справка не должна читать stdin");
  },
};
const helpRoutes = commandRoutes(createProgram(isolatedRuntime).options.subCommands);
const helpContent = [
  {
    name: "поиск описывает предметные тексты и курсор",
    argv: ["search", "--help"],
    included: ["предметным текстам", "--cursor"],
    excluded: [],
  },
  {
    name: "открытие намерения описывает runId без недопустимого accept",
    argv: ["checkpoint", "open", "--help"],
    included: ["runId"],
    excluded: ["--accept"],
  },
  {
    name: "создание этапа описывает позиционирование before",
    argv: ["plan", "stage", "create", "--help"],
    included: ["--before"],
    excluded: [],
  },
] as const;
const invalidArguments = [
  {
    name: "неизвестный флаг вместе со справкой",
    argv: ["--help", "--unknown"],
    message: "Неизвестный параметр: --unknown",
  },
  {
    name: "значение у флага версии",
    argv: ["--version=unexpected"],
    message: "Недопустимое значение",
  },
  {
    name: "неизвестная команда вместе со справкой",
    argv: ["missing", "--help"],
    message: "Неизвестная команда: «missing»",
  },
  {
    name: "неизвестная команда после разделителя аргументов",
    argv: ["--", "missing"],
    message: "Неизвестная команда: «missing»",
  },
] as const;

/**
 * Собирает каждый зарегистрированный узел дерева в отдельный именованный случай справки.
 * Обход не запускает команды и не обращается к проекту.
 */
function commandRoutes(
  commands: ReadonlyMap<string, Command>,
  path: readonly string[] = [],
): readonly CommandRoute[] {
  const routes: CommandRoute[] = [];
  for (const [name, command] of commands) {
    const argv = [...path, name];
    routes.push({ name: argv.join(" "), argv });
    if (command.subCommands instanceof Map) {
      routes.push(...commandRoutes(command.subCommands, argv));
    }
  }
  return routes;
}

/**
 * Запускает CLI с недоступным проектом и собственными буферами потоков для каждого вызова.
 */
async function invoke(argv: readonly string[]): Promise<InvocationResult> {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(
    argv,
    {
      /**
       * Сохраняет полный stdout этого вызова.
       */
      stdout: (text): void => {
        stdout += text;
      },
      /**
       * Сохраняет полный stderr этого вызова.
       */
      stderr: (text): void => {
        stderr += text;
      },
    },
    isolatedRuntime,
  );
  return { exitCode, stdout, stderr };
}

describe("Потоки и изоляция CLI", () => {
  test("закрытый получателем stdout завершает вызов успешно без диагностики", async () => {
    let stderr = "";

    const exitCode = await runCli(
      ["--version"],
      {
        /**
         * Воспроизводит закрытую принимающую сторону stdout.
         */
        stdout: (): never => {
          throw Object.assign(new Error("запись не удалась"), { code: "EPIPE" });
        },
        /**
         * Фиксирует диагностику, которая не должна появляться для EPIPE.
         */
        stderr: (text): void => {
          stderr += text;
        },
      },
      isolatedRuntime,
    );

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
  });

  test("ошибка записи EIO завершает вызов с INTERNAL_ERROR и исходной диагностикой", async () => {
    let stderr = "";

    const exitCode = await runCli(
      ["--version"],
      {
        /**
         * Воспроизводит отказ записи, отличный от штатного закрытия pipe.
         */
        stdout: (): never => {
          throw Object.assign(new Error("запись не удалась"), { code: "EIO" });
        },
        /**
         * Захватывает объяснение исходного отказа записи.
         */
        stderr: (text): void => {
          stderr += text;
        },
      },
      isolatedRuntime,
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain("INTERNAL_ERROR");
    expect(stderr).toContain("запись не удалась");
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
    expect(invalid.stderr).toContain("INVALID_ARGUMENT");
    expect(invalid.stderr).toContain("Неизвестный параметр: --unknown");
    expect(invalid.stderr.match(/Ошибка:/g)).toHaveLength(1);
  });

  test.each(invalidArguments)(
    "$name направляет INVALID_ARGUMENT только в stderr",
    async ({ argv, message }) => {
      const result = await invoke(argv);

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("INVALID_ARGUMENT");
      expect(result.stderr).toContain(message);
      expect(result.stderr).toContain("Справка: relay --help");
    },
  );
});

describe("Справка CLI", () => {
  test.each(helpRoutes)("$name показывает справку без чтения проекта и stdin", async ({ argv }) => {
    const help = await invoke([...argv, "--help"]);

    expect(help.exitCode).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toContain("ИСПОЛЬЗОВАНИЕ:");
  });

  test("пустой вызов и --help показывают одинаковую русскую справку", async () => {
    const help = await invoke(["--help"]);
    const empty = await invoke([]);

    expect(help.exitCode).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toContain("ИСПОЛЬЗОВАНИЕ:");
    expect(help.stdout).toContain("Показать справку");
    expect(help.stdout).toContain("Показать версию");
    expect(empty).toEqual(help);
  });

  test.each(helpContent)("$name", async ({ argv, included, excluded }) => {
    const help = await invoke(argv);

    expect(help.exitCode).toBe(0);
    expect(help.stderr).toBe("");
    for (const fragment of included) {
      expect(help.stdout).toContain(fragment);
    }
    for (const fragment of excluded) {
      expect(help.stdout).not.toContain(fragment);
    }
  });

  test("несуществующий каталог алиасов inspect keys отклоняется вместо показа справки", async () => {
    const result = await invoke(["inspect", "keys", "--help"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("INVALID_ARGUMENT");
  });
});
