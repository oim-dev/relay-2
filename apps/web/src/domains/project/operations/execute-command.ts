import type { BatchResult, HttpCommandRequest, NamedCommand } from "@relay/contracts";
import { relayClient, RelayApiError } from "infra/relay-api";
import { commandFailure, CommandFailure, errorMessage } from "../command-failure";
import { projectDataMessages } from "../project.messages";
import type { ProjectScopeValue } from "../types/project.types";

const uncertainRequests = new Map<string, HttpCommandRequest>();
const activeRequests = new Map<string, Promise<BatchResult>>();
const confirmedReceipts = new Map<string, BatchResult>();

/**
 * Проверяет receipt после потери ответа и повторяет только первоначальный запрос.
 * Классификация отказа не очищает key при неизвестном исходе.
 */
async function sendCommand(
  scope: ProjectScopeValue,
  key: string,
  submitted: HttpCommandRequest,
  original: HttpCommandRequest | undefined,
): Promise<BatchResult> {
  try {
    if (original) {
      try {
        const receipt = await relayClient.receipt(scope.projectId, submitted.operationKey);
        uncertainRequests.delete(key);
        return receipt.data;
      } catch (error) {
        if (!(error instanceof RelayApiError) || error.status !== 404) {
          throw new CommandFailure("RECEIPT_UNKNOWN", errorMessage(error), true);
        }
      }
    }
    uncertainRequests.set(key, submitted);
    const result = await relayClient.command(scope.projectId, submitted);
    uncertainRequests.delete(key);
    return result.data;
  } catch (error) {
    const confirmed = confirmedReceipts.get(key);
    if (confirmed !== undefined) {
      uncertainRequests.delete(key);
      return confirmed;
    }
    const failure = error instanceof CommandFailure ? error : commandFailure(error);
    if (!failure.uncertain) {
      uncertainRequests.delete(key);
    }
    throw failure;
  }
}

/**
 * Один operationKey имеет не более одного активного HTTP-сценария во вкладке.
 * Возврат A → B → A присоединяется к незавершённому исходному запросу, а не создаёт
 * конкурентный повтор до появления его receipt. Ввод и автор остаются исходными.
 */
export async function executeProjectCommand(
  scope: ProjectScopeValue,
  command: NamedCommand,
  operationKey: string,
): Promise<BatchResult> {
  const key = JSON.stringify([scope.serverKey, scope.projectId, operationKey]);
  const submitted = { ...structuredClone(command), actor: scope.actor, operationKey };
  const original = uncertainRequests.get(key);
  if (original && JSON.stringify(original) !== JSON.stringify(submitted)) {
    throw new CommandFailure("UNRESOLVED_OPERATION", projectDataMessages.unresolved, true);
  }
  const running = activeRequests.get(key);
  if (running) {
    return running;
  }
  const request = sendCommand(scope, key, submitted, original);
  activeRequests.set(key, request);
  try {
    return await request;
  } finally {
    if (activeRequests.get(key) === request) {
      activeRequests.delete(key);
      confirmedReceipts.delete(key);
    }
  }
}

/**
 * Читает первоначальный результат без повторного POST, независимо от текущего статуса
 * владельца. 404 и транспортный отказ не доказывают отсутствия эффектов и не очищают key.
 */
export async function recoverProjectCommand(
  scope: ProjectScopeValue,
  operationKey: string,
): Promise<BatchResult> {
  const result = await relayClient.receipt(scope.projectId, operationKey);
  const key = JSON.stringify([scope.serverKey, scope.projectId, operationKey]);
  if (activeRequests.has(key)) {
    confirmedReceipts.set(key, result.data);
  } else {
    uncertainRequests.delete(key);
  }
  return result.data;
}
