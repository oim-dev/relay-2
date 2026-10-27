import type { BatchResult, NamedCommand } from "@relay/contracts";
import { relayClient } from "infra/tasks-api";
import { createWriteCommands } from "./write-commands";

export { UncertainWriteError } from "./write-commands";

/**
 * Записывает пакет через единственный транспорт и реестр операций текущей вкладки.
 */
export const writeCommands = createWriteCommands(relayClient);

/**
 * Возвращает стабильный снимок неопределённой записи проекта без выполнения I/O.
 */
export const getPendingWrite = writeCommands.getPendingWrite;

/**
 * Подписывает временное recovery-уведомление; отписка не удаляет замороженный запрос.
 */
export const subscribePendingWrite = writeCommands.subscribePendingWrite;

/**
 * Явно восстанавливает первоначальный запрос по его ключу независимо от исходной формы.
 */
export const recoverPendingWrite = writeCommands.recoverPendingWrite;

/**
 * Одиночная команда использует тот же receipt/guards путь, что атомарный пакет.
 */
export function writeCommand(
  project: string,
  command: NamedCommand,
  operationKey?: string,
): Promise<BatchResult> {
  return writeCommands(project, [command], operationKey);
}
