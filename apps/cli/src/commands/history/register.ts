import type { Args } from "gunshi";
import {
  inputArgs,
  pageArgs,
  positional,
  refArgs,
  repeated,
  string,
  textArgs,
  flag,
} from "../../input/arguments";
import { remapInput } from "../../input/input";
import { CliUsageError } from "../../errors/errors";
import { historyCommandMessages as messages } from "../../locales/commands/history";
import { result } from "../../output/output";
import type { Result } from "../../output/output.types";
import type { CommandRegistry } from "../../execution/registry";
import type { Invocation } from "../../execution/invocation";

const participation = {
  client: string(messages.fields.client),
  "source-session-id": string(messages.fields.sourceSessionId),
  "user-name": string(messages.fields.userName),
  "user-email": string(messages.fields.userEmail),
  ...textArgs("reason"),
};

/**
 * Возвращает копию внешнего ввода истории с именами полей Core.
 * При withOperator явные userName/userEmail имеют приоритет над окружением;
 * готовый operator исключает подстановку окружения и несовместим с явными полями.
 * Значения и предметные ограничения проверяет Core, исходный ввод не изменяется.
 */
function historyInput(i: Invocation, withOperator = false): Record<string, unknown> {
  const input = remapInput(i.input, { run: "runId", accept: "acceptedSessionIds" });
  if (!withOperator) {
    return input;
  }
  const explicit = input.userName !== undefined || input.userEmail !== undefined;
  const environment =
    i.runtime.env.RELAY_USER_NAME !== undefined || i.runtime.env.RELAY_USER_EMAIL !== undefined;
  if (explicit && input.operator !== undefined) {
    throw new CliUsageError(messages.conflictingOperator, "CONFLICTING_OPTIONS");
  }
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

/**
 * Возвращает признак команды, принимающей поля нового участия вместо ссылки на текущий run.
 */
function usesParticipationInput(action: string): boolean {
  return action === "attach" || action === "resume" || action === "takeover";
}

/**
 * Возвращает схему CLI и допустимые JSON-алиасы для перехода поручения.
 * При подключении доступны поля оператора, при остальных переходах — ссылка на участие.
 */
function historyTransitionFields(action: string): Args {
  if (usesParticipationInput(action)) {
    return inputArgs(participation, ["operator"]);
  }
  if (action === "fork") {
    return inputArgs(
      {
        run: string(messages.fields.runId),
        title: string(messages.fields.forkTitle),
        ...textArgs("description"),
      },
      ["runId"],
    );
  }
  return inputArgs(
    { run: string(messages.fields.runId), ...textArgs(action === "pause" ? "reason" : "result") },
    ["runId"],
  );
}

/**
 * Добавляет в реестр команды поручений, участия и материалов без открытия проекта.
 * Core владеет состояниями, авторами и ревизиями; реестр объединяет действия обработчика
 * в транзакцию записи либо согласованный снимок чтения.
 */
export function registerHistoryCommands(registry: CommandRegistry): void {
  registry.group("session", messages.session);
  registry.add("session list", {
    description: messages.list,
    args: pageArgs,
    fields: {
      q: string(messages.fields.query),
      status: string(messages.fields.status),
      parent: string(messages.fields.parent),
      unfinished: flag(messages.fields.unfinished),
      "actor-filter": string(messages.fields.actorFilter),
    },
    /**
     * Возвращает страницу поручений после преобразования синтаксиса фильтров CLI.
     * Строка parent=null означает отсутствие родителя; Core читает весь набор до пагинации.
     */
    run: (i): Result => {
      const filters = remapInput(i.input, { actorFilter: "actor" });
      if (filters.parent === "null") {
        filters.parent = null;
      }
      return i.page(i.history.list(filters));
    },
  });
  registry.add("session get", {
    description: messages.get,
    args: refArgs,
    /**
     * Возвращает полную запись поручения по ссылке, разрешённой Core.
     */
    run: (i): Result => result(i.history.get(i.text("ref"))),
  });
  registry.add("session start", {
    description: messages.start,
    mode: "create",
    fields: inputArgs(
      { title: string(messages.fields.title), ...textArgs("description"), ...participation },
      ["operator"],
    ),
    /**
     * Возвращает поручение, атомарно созданное Core вместе с первым участием.
     * Поля оператора выбираются из явного ввода или окружения до предметной проверки.
     */
    run: (i): Result => result(i.history.start(historyInput(i, true), i.actor)),
  });
  registry.add("session history", {
    description: messages.history,
    args: { ref: positional(messages.fields.branch, false), ...pageArgs },
    /**
     * Возвращает страницу полной истории проекта либо выбранного поручения в одном снимке.
     * Отсутствующая ссылка выбирает историю всего проекта.
     */
    run: (i): Result => i.page(i.history.history(i.text("ref") || undefined)),
  });
  for (const action of [
    "fork",
    "attach",
    "pause",
    "resume",
    "takeover",
    "complete",
    "cancel",
  ] as const) {
    registry.add(`session ${action}`, {
      description: messages.transitions[action],
      mode: "update",
      args: refArgs,
      fields: historyTransitionFields(action),
      /**
       * Возвращает поручение после атомарного перехода Core; повтор не считается no-op.
       * Для fork ревизия принадлежит родителю намерения, для остальных действий — выбранной сессии.
       */
      run: (i): Result =>
        result(
          i.history.transition(
            i.text("ref"),
            action,
            historyInput(i, usesParticipationInput(action)),
            i.write,
          ),
        ),
    });
  }
  registry.add("session tree", {
    description: messages.tree,
    args: { ...refArgs, ...pageArgs },
    /**
     * Возвращает страницу дерева поручений; Core строит полное дерево до пагинации.
     */
    run: (i): Result => i.page(i.history.tree(i.text("ref"))),
  });
  registry.add("session intents", {
    description: messages.intents,
    args: { ...refArgs, ...pageArgs, "include-children": flag(messages.fields.includeChildren) },
    /**
     * Возвращает страницу открытых намерений; весь выбранный набор читается в снимке команды.
     */
    run: (i): Result =>
      i.page(i.history.intents(i.text("ref"), i.values["include-children"] === true)),
  });
  registry.add("session context", {
    description: messages.context,
    args: { ...refArgs, ...pageArgs },
    /**
     * Возвращает контекст поручения и страницу материалов из общего снимка.
     * Полная история материалов загружается до ограничения страницы.
     */
    run: (i): Result => {
      const { checkpoints, ...context } = i.history.context(i.text("ref"));
      return i.page(checkpoints, context);
    },
  });
  registry.group("checkpoint", messages.checkpoint);
  registry.add("checkpoint get", {
    description: messages.checkpointGet,
    args: refArgs,
    /**
     * Возвращает полную неизменяемую контрольную точку по ссылке, разрешённой Core.
     */
    run: (i): Result => result(i.history.getCheckpoint(i.text("ref"))),
  });
  for (const action of ["open", "save", "complete", "cancel"] as const) {
    registry.add(`checkpoint ${action}`, {
      description: messages.checkpointActions[action],
      mode: "update",
      args: refArgs,
      fields: inputArgs(
        {
          run: string(messages.fields.runId),
          title: string(messages.fields.checkpointTitle),
          ...textArgs("body", "summary", "done", "remaining", "next-step", "checks"),
          references: repeated(messages.fields.reference),
          ...(action === "open" ? {} : { accept: repeated(messages.fields.acceptedSessionId) }),
        },
        action === "open" ? ["runId"] : ["runId", "acceptedSessionIds"],
      ),
      /**
       * Возвращает новый материал, записанный Core атомарно с повышением ревизии сессии.
       * ifRevision относится к сессии, исходный checkpoint не изменяется; повтор не является no-op.
       */
      run: (i): Result =>
        result(i.history.checkpoint(i.text("ref"), action, historyInput(i), i.write)),
    });
  }
}
