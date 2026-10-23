import { describe, expect, test } from "bun:test";
import { version } from "../../package.json";
import {
  commandRoutes,
  helpRuntime as isolatedRuntime,
  invokeIsolatedCli as invoke,
} from "../../tests/helpers/help";
import { runCli } from "./run";
import { createProgram } from "./program";
const helpRoutes = commandRoutes(createProgram(isolatedRuntime).options.subCommands);
const helpContent = [
  {
    name: "изменение критерия объясняет сброс приёмки и запрет в done",
    argv: ["task", "criterion", "update", "--help"],
    included: [
      "сбрасывает отметку выполнения",
      "При неизменном содержании",
      "В колонке done любые изменения критериев запрещены",
      "task move",
    ],
    excluded: ["Отметка выполнения меняется через complete/reopen"],
  },
  {
    name: "принятие ребёнка требует постоянный ID из карточки сессии",
    argv: ["checkpoint", "save", "--help"],
    included: ["Только постоянный ID", "поле id из session get", "ключ не принимается"],
    excluded: ["ID или ключ завершённого"],
  },
  {
    name: "публикация релиза требует явного завершения каждого плана",
    argv: ["release", "publish", "--help"],
    included: ["каждый план", "completed", "plan complete", "--result"],
    excluded: [],
  },
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
  {
    name: "задача объясняет Markdown и новую форму критериев",
    argv: ["task", "create", "--help"],
    included: [
      "цель, основания, работа, границы и проверка",
      "--acceptance-criteria",
      "acceptanceCriteria",
      "## Проверка",
    ],
    excluded: ["--criterion-title", "Содержание: description", "--server-url"],
  },
  {
    name: "изменение задачи объясняет замену и явное очищение набора",
    argv: ["task", "update", "--help"],
    included: [
      "Неуказанные поля сохраняются",
      "заменяет весь набор",
      "--input '{\"targets\":[]}'",
      "task get",
    ],
    excluded: ["--clear-targets"],
  },
  {
    name: "раздел документа использует ревизию проекта",
    argv: ["document", "section", "remove", "--help"],
    included: ["ревизия проекта", "Документы сохраняются", "ID раздела остаётся зарезервированным"],
    excluded: [],
  },
  {
    name: "перенос задачи объясняет порядок аргументов и обе ревизии",
    argv: ["plan", "stage", "task", "transfer", "--help"],
    included: [
      "исходный план, задача, ID целевого этапа",
      "--target-revision",
      "одинаковые ревизии",
      "непустая reason",
    ],
    excluded: [],
  },
  {
    name: "ветвление истории адресует intent и ревизию родителя",
    argv: ["session", "fork", "--help"],
    included: ["checkpoint вида intent", "родительской сессии", "--run", "session attach"],
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
    name: "неизвестный флаг вместе с версией",
    argv: ["--version", "--unknown"],
    message: "Неизвестный параметр: --unknown",
  },
  {
    name: "переданный format без обязательного значения",
    argv: ["--format"],
    message: "Не указано значение параметра '--format'",
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

const contextualErrors = [
  {
    name: "отсутствующий аргумент",
    argv: ["task", "get"],
    help: "relay task get --help",
    code: "INVALID_ARGUMENT",
  },
  {
    name: "неизвестное действие",
    argv: ["task", "creat"],
    help: "relay task --help",
    code: "INVALID_ARGUMENT",
  },
  {
    name: "неизвестное действие вложенной группы участия",
    argv: ["application", "participation", "missing"],
    help: "relay application participation --help",
    code: "INVALID_ARGUMENT",
  },
  {
    name: "неизвестный вложенный параметр",
    argv: ["task", "criterion", "add", "--unknown"],
    help: "relay task criterion add --help",
    code: "INVALID_ARGUMENT",
  },
  {
    name: "глобальный параметр перед путём команды",
    argv: ["--config", "/missing", "document", "get"],
    help: "relay document get --help",
    code: "INVALID_ARGUMENT",
  },
  {
    name: "конфликт источников до чтения stdin",
    argv: ["document", "create", "--body", "Текст", "--body-file", "-"],
    help: "relay document create --help",
    code: "CONFLICTING_OPTIONS",
  },
] as const;

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

  test.each(contextualErrors)(
    "$name направляет к справке выбранной команды",
    async ({ argv, help, code }) => {
      const response = await invoke(argv);

      expect(response.exitCode).toBe(2);
      expect(response.stdout).toBe("");
      expect(response.stderr).toContain(code);
      expect(response.stderr).toContain(`Справка: ${help}\n`);
      expect(response.stderr.match(/Справка:/g)).toHaveLength(1);
    },
  );

  test.each(contextualErrors)(
    "$name возвращает адрес справки отдельным полем JSON-ошибки",
    async ({ argv, help, code }) => {
      const response = await invoke([...argv, "--format=json"]);

      expect(response.exitCode).toBe(2);
      expect(response.stdout).toBe("");
      const parsed = JSON.parse(response.stderr);
      expect(parsed).toMatchObject({ ok: false, error: { code, helpCommand: help } });
      expect(parsed.error.message).not.toContain("Справка:");
      expect(response.stderr.trim().split("\n")).toHaveLength(1);
    },
  );

  test("параллельные ошибки сохраняют независимые пути справки и JSON", async () => {
    const [task, document, json] = await Promise.all([
      invoke(["task", "get"]),
      invoke(["document", "get"]),
      invoke(["plan", "get", "--format", "json"]),
    ]);

    expect(task.stderr).toContain("Справка: relay task get --help");
    expect(document.stderr).toContain("Справка: relay document get --help");
    expect(json.exitCode).toBe(2);
    expect(json.stdout).toBe("");
    expect(JSON.parse(json.stderr)).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENT", helpCommand: "relay plan get --help" },
    });
  });
});

describe("Справка CLI", () => {
  test.each(helpRoutes)("$name показывает справку без чтения проекта и stdin", async ({ argv }) => {
    const help = await invoke([...argv, "--help"]);

    expect(help.exitCode).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toContain("ИСПОЛЬЗОВАНИЕ:");
    expect(help.stdout).toContain("ПОДРОБНОСТИ:\n");
    expect(help.stdout).toContain("ПРИМЕРЫ:\n  # ");
    expect(help.stdout).toContain("--format <format>");
    expect(help.stdout).not.toContain("--format [format]");
    expect(help.stdout).not.toContain("Содержание: ");
    expect(help.stdout).not.toContain("\u001b");
  });

  test.each(helpRoutes.filter((route) => route.group))(
    "$name без подкоманды совпадает с --help и сохраняет полный путь",
    async ({ argv }) => {
      const help = await invoke([...argv, "--help"]);
      const empty = await invoke(argv);

      expect(empty).toEqual(help);
      expect(help.stdout).toContain(`ИСПОЛЬЗОВАНИЕ:\n  relay ${argv.join(" ")} [КОМАНДЫ]`);
    },
  );

  test("описание действия выводится один раз, а -h с JSON остаётся текстовой справкой", async () => {
    const help = await invoke(["task", "create", "--help"]);
    const short = await invoke([
      "task",
      "create",
      "-h",
      "--format",
      "json",
      "--description-file",
      "-",
    ]);

    expect(short).toEqual(help);
    expect(
      help.stdout.startsWith("Создать задачу с критериями и связями атомарно\n\nИСПОЛЬЗОВАНИЕ:"),
    ).toBe(true);
    expect(help.stdout.match(/Создать задачу с критериями и связями атомарно/g)).toHaveLength(1);
  });

  test("пустой вызов и --help показывают одинаковую русскую справку", async () => {
    const help = await invoke(["--help"]);
    const empty = await invoke([]);

    expect(help.exitCode).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toContain("ИСПОЛЬЗОВАНИЕ:");
    expect(help.stdout).toContain("Показать справку");
    expect(help.stdout).toContain("Показать версию");
    expect(help.stdout).toContain("--format <format>");
    expect(help.stdout).toContain("по умолчанию: text, допустимые значения: text | json");
    expect(empty).toEqual(help);
  });

  test("значение limit обязательно после флага, а необязательный ref сохраняет скобки", async () => {
    const history = await invoke(["session", "history", "--help"]);

    expect(history.exitCode).toBe(0);
    expect(history.stdout).toContain("--limit <limit>");
    expect(history.stdout).toContain("по умолчанию: 20");
    expect(history.stdout).toContain("[<ref>]");
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
