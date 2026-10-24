import { beforeAll, describe, expect, test } from "bun:test";
import { cli } from "gunshi";
import { HistoryService, PlanningService, TasksService } from "@relay/core";
import { createProgram } from "../../src/app/program";
import { enableCompletion } from "../../src/app/completion";
import { commandRoutes, helpExamples, helpRuntime, invokeIsolatedCli } from "../helpers/help";
import type { CommandRoute } from "../helpers/run-fixture.types";
import { withCliFixture } from "../integration/helpers/cli-fixture";
import { invokeBinary } from "./cli-process";
import type { HelpExampleCall, ValidatedHelpExample } from "./help-examples.types";
import { literalExampleCalls } from "./literal-examples";
import { CliUsageError } from "../../src/errors/errors";

const routes: readonly CommandRoute[] = [
  { name: "relay", argv: [], group: true },
  ...commandRoutes(createProgram(helpRuntime).options.subCommands),
  { name: "complete", argv: ["complete"], group: false },
];
const expectedTaskDescription =
  "## Цель\n\nПользователь может повторить поиск после отказа API.\n\n## Работа и границы\n\nСохранить введённый запрос и показать кнопку повтора. Алгоритм поиска не меняется.\n\n## Проверка\n\nВоспроизвести отказ API и убедиться, что повтор использует исходный запрос.";
const invalidExamples = [
  {
    name: "опечатка во флаге",
    argv: ["task", "create", "--titel", "Заголовок", "--actor", "human"],
    errorType: AggregateError,
  },
  {
    name: "нет ни локального, ни переносимого предусловия",
    argv: ["plan", "start", "PLN-1", "--actor", "human"],
    errorType: CliUsageError,
  },
  {
    name: "неизвестное значение enum",
    argv: ["task", "create", "--column", "wrong", "--actor", "human"],
    errorType: AggregateError,
  },
  {
    name: "неизвестный флаг вместе со справкой",
    argv: ["task", "create", "--help", "--unknown"],
    errorType: AggregateError,
  },
] as const;
const informationalExamples = [
  {
    name: "справка без обязательных аргументов",
    argv: ["checkpoint", "open", "--help"],
    path: "checkpoint open",
  },
  { name: "версия CLI", argv: ["--version"], path: "" },
] as const;

let calls: readonly HelpExampleCall[] = [];

/**
 * Декодирует NUL-протокол заглушки relay, сохраняя границы, пустоту и переводы строк аргументов.
 */
function parseCalls(stdout: string): readonly HelpExampleCall[] {
  const tokens = stdout.split("\0");
  expect(tokens.pop()).toBe("");
  const result: HelpExampleCall[] = [];
  let offset = 0;
  while (offset < tokens.length) {
    const route = Number(tokens[offset++]);
    const count = Number(tokens[offset++]);
    expect(Number.isInteger(route) && route >= 0 && route < routes.length).toBe(true);
    expect(Number.isInteger(count) && count > 0 && offset + count <= tokens.length).toBe(true);
    result.push({ route, argv: tokens.slice(offset, offset + count) });
    offset += count;
  }
  return result;
}

/**
 * Выбирает первый показанный пример действия для проверки его реального результата на fixture.
 */
function exampleArguments(name: string): readonly string[] {
  const route = routes.findIndex((item) => item.name === name);
  const example = calls.find((item) => item.route === route);
  if (!example) {
    throw new Error(`Отсутствует пример ${name}`);
  }
  return example.argv;
}

/**
 * Пропускает пример через настоящий парсер и останавливает его до любого предметного действия.
 * Completion тоже проверяется через его регистрацию, не выполняя протокол или генерацию скрипта.
 * Ошибки и информационные вызовы проходят штатную обработку Gunshi: help допускает отсутствие
 * обязательных аргументов, но не неизвестные флаги. Ошибка разбора возвращается вызывающему тесту.
 */
async function validateExample(argv: readonly string[]): Promise<ValidatedHelpExample> {
  const program = createProgram(helpRuntime);
  enableCompletion(program);
  const stop = new Error("Пример остановлен до выполнения");
  let selected: string | undefined;
  let informational = false;
  try {
    await cli([...argv], program.command, {
      ...program.options,
      /**
       * Останавливает только валидное действие; ошибки и help/version обрабатывает сам Gunshi.
       */
      onBeforeCommand(context): void {
        program.options.onBeforeCommand(context);
        selected = context.commandPath.join(" ");
        informational = context.values.help === true || context.values.version === true;
        if (context.validationError || informational) {
          return;
        }
        throw stop;
      },
    });
    if (!informational) {
      throw new Error(`Пример не остановлен до обработчика: ${argv.join(" ")}`);
    }
  } catch (error) {
    if (error !== stop) {
      throw error;
    }
  }
  if (selected === undefined) {
    throw new Error("Пример не достиг распознанной команды");
  }
  return { path: selected, informational };
}

describe("Копируемые примеры справки", () => {
  beforeAll(async () => {
    // Один Bash для всего неизменяемого каталога. PATH пуст: выполняется только функция-заглушка.
    const script = ["set -e", "PATH=", 'relay() { printf \'%s\\0\' "$route" "$#" "$@"; }'];
    const literalCalls: HelpExampleCall[] = [];
    for (const [index, route] of routes.entries()) {
      const help =
        route.name === "complete"
          ? await invokeBinary(["complete", "--help"], { openStdin: true })
          : await invokeIsolatedCli([...route.argv, "--help"]);
      expect(help.exitCode).toBe(0);
      expect(help.stderr).toBe("");
      script.push(`route=${index}`, helpExamples(help.stdout));
      literalCalls.push(...literalExampleCalls(helpExamples(help.stdout), index));
    }

    // Windows сохраняет проверки каждого примера через Gunshi и реальные предметные сценарии.
    // Только дополнительная сверка POSIX shell-семантики требует настоящего Bash на POSIX.
    if (process.platform === "win32") {
      calls = literalCalls;
      return;
    }

    const parsed = await invokeBinary([], {
      command: ["bash", "--noprofile", "--norc", "-c", script.join("\n")],
    });

    expect(parsed.exitCode).toBe(0);
    expect(parsed.stderr).toBe("");
    expect(parsed.files).toEqual([]);
    calls = parseCalls(parsed.stdout);
    expect(calls).toEqual(literalCalls);
  });

  test.each(invalidExamples)(
    "$name отклоняется проверкой примеров",
    async ({ argv, errorType }) => {
      await expect(validateExample(argv)).rejects.toBeInstanceOf(errorType);
    },
  );

  test.each(informationalExamples)(
    "$name проходит штатную информационную ветку",
    async ({ argv, path }) => {
      const parsed = await validateExample(argv);

      expect(parsed).toEqual({ path, informational: true });
    },
  );

  test.each(routes)(
    "$name: показанные примеры разбираются и содержат собственное действие",
    async (route) => {
      const index = routes.indexOf(route);
      const examples = calls.filter((call) => call.route === index);
      expect(examples.length).toBeGreaterThan(0);
      let ownAction = false;

      for (const example of examples) {
        const selected = await validateExample(example.argv);
        ownAction ||= selected.path === route.name && !selected.informational;
      }

      if (!route.group) {
        expect(ownAction, route.name).toBe(true);
      }
    },
  );

  test("скопированный пример создания задачи сохраняет точный Markdown и критерий", async () => {
    await withCliFixture(async (fixture) => {
      const project = fixture.createProject();
      const argv = exampleArguments("task create");

      const task = await fixture.entity(argv);
      const stored = fixture.withDatabase(project, (db) => new TasksService(db).get(task.id));

      expect(stored.data.title).toBe("Сохранить запрос при ошибке поиска");
      expect(stored.data.description).toBe(expectedTaskDescription);
      expect(stored.createdBy).toBe("human");
      expect(stored.data.acceptanceCriteria).toHaveLength(1);
      expect(stored.data.acceptanceCriteria[0]).toMatchObject({
        title: "Запрос сохраняется после ошибки",
        description: "Воспроизвести отказ API и повторить поиск без нового ввода.",
        completed: false,
      });
    });
  });

  test("пример выпуска использует release-version и включает подготовленный план", async () => {
    await withCliFixture(async (fixture) => {
      const project = fixture.createProject();
      const plan = await fixture.withDatabase(
        project,
        async (db) =>
          await new PlanningService(db).create(
            "work-plan",
            { title: "План для выпуска" },
            "fixture",
          ),
      );
      const argv = exampleArguments("release create").map((arg) =>
        arg === "PLN-1" ? plan.key : arg,
      );

      const release = await fixture.entity(argv);

      expect(release.data).toMatchObject({
        title: "Восстановление поиска",
        version: "1.2.0",
        planIds: [plan.id],
        status: "planned",
      });
    });
  });

  test("пример открытия намерения передаёт активный run и ревизию сессии", async () => {
    await withCliFixture(async (fixture) => {
      const project = fixture.createProject();
      const session = await fixture.withDatabase(
        project,
        async (db) => await new HistoryService(db).start({ title: "Проверка примера" }, "human"),
      );
      const argv = exampleArguments("checkpoint open").map((arg) => {
        if (arg === "S-session") {
          return session.key;
        }
        if (arg === "run-id") {
          return session.data.currentRunId ?? "missing-run";
        }
        return arg;
      });

      const checkpoint = await fixture.entity(argv);
      const stored = fixture.withDatabase(project, (db) => new HistoryService(db).get(session.id));

      expect(checkpoint.data).toMatchObject({
        sessionId: session.id,
        runId: session.data.currentRunId,
        kind: "intent",
        body: "Воспроизвести HTTP 503, повторить поиск и проверить сохранность запроса.",
      });
      expect(stored.revision).toBe(session.revision + 1);
    });
  });
});
