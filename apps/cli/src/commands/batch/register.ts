import { BATCH_OPERATIONS, BatchService } from "@relay/core";
import type { BatchResult } from "@relay/contracts";
import { choice, flag, positional, string } from "../../input/arguments";
import { batchCommandMessages as messages } from "../../locales/commands/batch";
import { result } from "../../output/output";
import type { Result } from "../../output/output.types";
import type { CommandRegistry } from "../../execution/registry";
import { readBatchInput } from "./input";
import { registerBatchHelp } from "./help-navigation";

/**
 * Отделяет компактную квитанцию от полного ответа без повторного чтения изменённых сущностей.
 */
function batchResult(data: BatchResult, full: boolean): Result {
  const { entities, ...receipt } = data;
  return result(full ? { ...receipt, entities } : receipt);
}

/**
 * Регистрирует выполнение пакета и чтение квитанции; транзакцией и --check владеет BatchService.
 * CLI открывает одно соединение после чтения входа и закрывает его независимо от результата.
 */
export function registerBatchCommands(registry: CommandRegistry): void {
  registry.add("batch", {
    ...messages.execute,
    mode: "create",
    execution: "service",
    args: {
      input: string(messages.input, true),
      "operation-key": string(messages.operationKey),
      check: flag(messages.check),
      return: choice(messages.return, ["full"]),
    },
    readInput: readBatchInput,
    /**
     * Передаёт автора, ключ и исходные ревизии без подстановки и внешней транзакции.
     */
    run: async (i): Promise<Result> =>
      batchResult(
        await new BatchService(i.db).execute(i.input, {
          ...i.commandExecution,
          actor: i.actor,
          ...(i.values["operation-key"] !== undefined
            ? { operationKey: i.text("operation-key") }
            : {}),
          check: i.values.check === true,
        }),
        i.values.return === "full",
      ),
  });
  registry.add("batch result", {
    ...messages.result,
    args: {
      key: positional(messages.operationKey),
      return: choice(messages.return, ["full"]),
    },
    execution: "service",
    /**
     * Читает сохранённую исходную квитанцию, включая полный состав при явном --return full.
     */
    run: (i): Result =>
      batchResult(new BatchService(i.db).getResult(i.text("key")), i.values.return === "full"),
  });
  registerBatchHelp(registry, BATCH_OPERATIONS);
}
