import type {
  HistoryCheckpointAction,
  HistoryCheckpointInput,
  NamedCommand,
} from "@relay/contracts";
import type { HistorySource, SessionChange } from "./history.types";
import { historyCommandMessages } from "./history.messages";

/**
 * Сохраняет исходные guards сессии даже при записи, адресующей её материал.
 */
function historyGuards(
  source: HistorySource | undefined,
): Pick<NamedCommand, "ifRevision" | "expectedVersion"> {
  if (source === undefined) {
    return {};
  }
  return {
    ifRevision: source.entity.revision,
    ...(source.expectedVersion === undefined ? {} : { expectedVersion: source.expectedVersion }),
  };
}

/**
 * Переводит публичный предметный переход в точную схему session.* Core.
 * Fork адресует намерение, но оба guard относятся к родительской сессии.
 */
export function sessionCommand(change: SessionChange, source?: HistorySource): NamedCommand {
  if (change.action === "start") {
    return {
      op: "session.start",
      input: {
        title: change.title,
        ...(change.description === undefined ? {} : { description: change.description }),
        client: "relay-web",
      },
    };
  }
  if (source === undefined) {
    throw new Error(historyCommandMessages.ownerRequired);
  }
  if (change.action === "fork") {
    return {
      op: "session.fork",
      ref: change.intent.id,
      ...historyGuards(source),
      input: {
        title: change.title,
        ...(change.description === undefined ? {} : { description: change.description }),
        runId: change.runId,
      },
    };
  }
  const { action, ...fields } = change;
  return {
    op: `session.${action}`,
    ref: source.entity.id,
    ...historyGuards(source),
    input: fields,
  };
}

/**
 * Открывает намерение на сессии или добавляет материал к исходному намерению.
 * Никакие поля существующего checkpoint не обновляются.
 */
export function checkpointCommand(
  source: HistorySource,
  action: HistoryCheckpointAction,
  intentId: string | undefined,
  input: HistoryCheckpointInput,
): NamedCommand {
  const ref = action === "open" ? source.entity.id : intentId;
  if (ref === undefined) {
    throw new Error(historyCommandMessages.intentRequired);
  }
  return { op: `checkpoint.${action}`, ref, ...historyGuards(source), input: { ...input } };
}
