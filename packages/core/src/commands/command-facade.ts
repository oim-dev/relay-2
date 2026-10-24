import {
  RelayError,
  type BatchResult,
  type CommandExecutionContext,
  type EntityRecord,
  type NamedCommand,
} from "@relay/contracts";
import type { ProjectStore } from "@relay/storage";
import { CommandExecutor } from "../batch/batch";
import { batchFields } from "../batch/batch-input";
import { commandMessages } from "./command.messages";
import { expectedCommandVersion } from "./command-write";

/**
 * Адаптирует одну предметную запись к единственному массивному исполнителю.
 */
export function executeCommand(
  db: ProjectStore,
  command: NamedCommand,
  actor: string,
  execution: CommandExecutionContext = {},
): Promise<BatchResult> {
  batchFields(execution, ["expectedAddresses", "expectedVersion"], "execution");
  const { ifRevision, expectedVersion, ...payload } = command;
  const version = expectedCommandVersion(expectedVersion, execution.expectedVersion);
  return new CommandExecutor(db, { legacyFacade: true }).execute(
    {
      ...payload,
      ...(ifRevision === undefined ? {} : { ifRevision }),
      ...(version === undefined ? {} : { expectedVersion: version }),
    },
    {
      actor,
      ...(execution.expectedAddresses === undefined
        ? {}
        : { expectedAddresses: execution.expectedAddresses }),
    },
  );
}

/**
 * Возвращает карточку основного результата или владельца вложенного результата после atomic commit.
 */
export async function executeEntityCommand(
  db: ProjectStore,
  command: NamedCommand,
  actor: string,
  execution: CommandExecutionContext = {},
): Promise<EntityRecord> {
  const result = await executeCommand(db, command, actor, execution);
  const item = result.items[0];
  if (item === undefined) {
    throw new RelayError("CORRUPT_DATA", commandMessages.missingResult);
  }
  const record =
    result.entities.find((entry) => entry.id === item.id) ??
    result.entities.find((entry) => entry.id === item.owner.id);
  if (record === undefined) {
    throw new RelayError("CORRUPT_DATA", commandMessages.missingResult);
  }
  return { ...record, data: { ...record.data } };
}
