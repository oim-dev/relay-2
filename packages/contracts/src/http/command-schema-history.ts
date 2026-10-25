import { historyOperatorSources } from "../history/history.constants";
import {
  commandAddress as address,
  commandArray,
  commandEnum,
  commandNonblank,
  commandNullable,
  commandObject,
} from "./command-schema-fields";
import type { CommandJsonSchema } from "./command-schema.types";

const line: CommandJsonSchema = { ...commandNonblank, not: { pattern: "[\\r\\n]" } };
const connection = {
  client: line,
  sourceSessionId: {
    ...line,
    description: "ID сессии внешнего клиента; не ссылка на сущность Relay.",
  },
  reason: commandNonblank,
  operator: {
    ...commandNullable(
      commandObject(
        {
          name: commandNullable(line),
          email: commandNullable(line),
          source: commandEnum(historyOperatorSources),
        },
        ["source"],
      ),
    ),
    description:
      "Явный null запрещает наследование; отсутствие использует правило подключения текущего действия Core.",
  },
};
const content = { title: line, description: commandNonblank };
const checkpoint = {
  runId: line,
  title: line,
  body: commandNonblank,
  summary: commandNonblank,
  done: commandNonblank,
  remaining: commandNonblank,
  nextStep: commandNonblank,
  checks: commandNonblank,
  references: { ...commandArray(address), uniqueItems: true },
};

/**
 * Формы истории: runId — буквальный ID, а не batch-ссылка; operator допускает явный null.
 */
export const historyCommandInputs: Readonly<Record<string, CommandJsonSchema>> = {
  "session.start": commandObject({ ...content, ...connection }, ["title"]),
  "session.fork": commandObject({ ...content, runId: line }, ["title", "runId"]),
  "session.attach": commandObject(connection),
  "session.resume": commandObject(connection),
  "session.takeover": commandObject(connection, ["reason"]),
  "session.pause": commandObject({ runId: line, reason: commandNonblank }, ["runId", "reason"]),
  "session.complete": commandObject({ runId: line, result: commandNonblank }, ["runId", "result"]),
  "session.cancel": commandObject(
    {
      runId: {
        ...line,
        description:
          "Для open-сессии обязателен; для pending/paused запрещён. Состояние и владельца проверяет Core.",
      },
      result: commandNonblank,
    },
    ["result"],
  ),
  "checkpoint.open": commandObject(checkpoint, ["runId", "title", "body"]),
  ...Object.fromEntries(
    ["save", "complete", "cancel"].map((action) => [
      `checkpoint.${action}`,
      commandObject(
        { ...checkpoint, acceptedSessionIds: { ...commandArray(address), uniqueItems: true } },
        ["runId", "title", "body"],
      ),
    ]),
  ),
};
