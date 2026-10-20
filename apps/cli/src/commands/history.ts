import {
  inputArgs,
  pageArgs,
  positional,
  refArgs,
  repeated,
  remapInput,
  string,
  textArgs,
  flag,
} from "../arguments";
import { CliUsageError } from "../errors";
import { type CommandRegistry, type Invocation, result } from "../registry";

const participation = {
  client: string("Клиент"),
  "source-session-id": string("ID исходной сессии клиента"),
  "user-name": string("Имя пользователя"),
  "user-email": string("Почта пользователя"),
  ...textArgs("reason"),
};

function historyInput(i: Invocation, withOperator = false): Record<string, unknown> {
  const input = remapInput(i.input, { run: "runId", accept: "acceptedSessionIds" });
  if (!withOperator) return input;
  const explicit = input.userName !== undefined || input.userEmail !== undefined;
  const environment =
    i.runtime.env.RELAY_USER_NAME !== undefined || i.runtime.env.RELAY_USER_EMAIL !== undefined;
  if (explicit && input.operator !== undefined)
    throw new CliUsageError("operator несовместим с userName/userEmail", "CONFLICTING_OPTIONS");
  if (explicit || (environment && input.operator === undefined)) {
    input.operator = {
      name: explicit ? (input.userName ?? null) : (i.runtime.env.RELAY_USER_NAME ?? null),
      email: explicit ? (input.userEmail ?? null) : (i.runtime.env.RELAY_USER_EMAIL ?? null),
      source: explicit ? "explicit" : "environment",
    };
  }
  delete input.userName;
  delete input.userEmail;
  return input;
}

export function registerHistoryCommands(registry: CommandRegistry): void {
  registry.group("session", "История поручений и участия агентов");
  registry.add("session list", {
    description: "Список веток поручений",
    args: pageArgs,
    fields: {
      q: string("Поиск"),
      status: string("Состояние"),
      parent: string("Родитель"),
      unfinished: flag("Только незавершённые"),
      "actor-filter": string("Автор участия"),
    },
    run: (i) => {
      const filters = remapInput(i.input, { actorFilter: "actor" });
      if (filters.parent === "null") filters.parent = null;
      return i.page(i.history.list(filters));
    },
  });
  registry.add("session get", {
    description: "Полное поручение, состояние и участие",
    args: refArgs,
    run: (i) => result(i.history.get(i.text("ref"))),
  });
  registry.add("session start", {
    description: "Начать корневое поручение",
    mode: "create",
    fields: inputArgs(
      { title: string("Заголовок"), ...textArgs("description"), ...participation },
      ["operator"],
    ),
    run: (i) => result(i.history.start(historyInput(i, true), i.actor)),
  });
  registry.add("session history", {
    description: "Сохранённая история проекта или выбранной ветки",
    args: { ref: positional("Ветка поручения", false), ...pageArgs },
    run: (i) => i.page(i.history.history(i.text("ref") || undefined)),
  });
  for (const action of ["fork", "attach", "pause", "resume", "takeover", "complete", "cancel"])
    registry.add(`session ${action}`, {
      description: {
        fork: "Создать дочернее поручение из намерения",
        attach: "Принять дочернее поручение",
        pause: "Приостановить участие",
        resume: "Продолжить участие",
        takeover: "Передать участие",
        complete: "Завершить поручение",
        cancel: "Отменить поручение",
      }[action]!,
      mode: "update",
      args: refArgs,
      fields: inputArgs(
        ["attach", "resume", "takeover"].includes(action)
          ? participation
          : action === "fork"
            ? {
                run: string("ID участия"),
                title: string("Заголовок дочернего поручения"),
                ...textArgs("description"),
              }
            : { run: string("ID участия"), ...textArgs(action === "pause" ? "reason" : "result") },
        ["attach", "resume", "takeover"].includes(action) ? ["operator"] : ["runId"],
      ),
      run: (i) =>
        result(
          i.history.transition(
            i.text("ref"),
            action,
            historyInput(i, ["attach", "resume", "takeover"].includes(action)),
            i.write,
          ),
        ),
    });
  registry.add("session tree", {
    description: "Ветка поручения и все потомки",
    args: { ...refArgs, ...pageArgs },
    run: (i) => i.page(i.history.tree(i.text("ref"))),
  });
  registry.add("session intents", {
    description: "Открытые намерения",
    args: { ...refArgs, ...pageArgs, "include-children": flag("Включить потомков") },
    run: (i) => i.page(i.history.intents(i.text("ref"), i.values["include-children"] === true)),
  });
  registry.add("session context", {
    description: "Поручение, дети, намерения и страница материалов",
    args: { ...refArgs, ...pageArgs },
    run: (i) => {
      const { checkpoints, ...context } = i.history.context(i.text("ref"));
      return i.page(checkpoints, context);
    },
  });
  registry.group("checkpoint", "Неизменяемые намерения и материалы выполнения");
  registry.add("checkpoint get", {
    description: "Полное содержание контрольной точки",
    args: refArgs,
    run: (i) => result(i.history.getCheckpoint(i.text("ref"))),
  });
  for (const action of ["open", "save", "complete", "cancel"] as const)
    registry.add(`checkpoint ${action}`, {
      description: {
        open: "Открыть намерение в сессии",
        save: "Сохранить материал намерения",
        complete: "Завершить намерение",
        cancel: "Отменить намерение",
      }[action],
      mode: "update",
      args: refArgs,
      fields: inputArgs(
        {
          run: string("ID участия"),
          title: string("Заголовок материала"),
          ...textArgs("body", "summary", "done", "remaining", "next-step", "checks"),
          references: repeated("Ссылка"),
          ...(action === "open" ? {} : { accept: repeated("ID принимаемого дочернего поручения") }),
        },
        action === "open" ? ["runId"] : ["runId", "acceptedSessionIds"],
      ),
      run: (i) => result(i.history.checkpoint(i.text("ref"), action, historyInput(i), i.write)),
    });
}
