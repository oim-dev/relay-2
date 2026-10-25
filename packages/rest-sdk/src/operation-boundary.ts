import type { HttpResponse } from "@relay/contracts";
import type { RelayResponse } from "./client.types";
import { RelayApiError } from "./errors";
import { clientMessages } from "./client.messages";

/**
 * Проверяет обязательную непустую строку без кодирования и изменения исходного значения.
 */
export function requiredParameter(name: string, value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RelayApiError(
      { code: "INVALID_ARGUMENT", message: clientMessages.missingParameter(name) },
      0,
    );
  }
  return value;
}

/**
 * Кодирует path-параметр до generated interpolation; query-кодирование остаётся HttpClient.
 */
export function pathParameter(name: string, value: string): string {
  return encodeURIComponent(requiredParameter(name, value));
}

/**
 * Сужает generated JSON union после проверки HTTP envelope общим responseParser.
 * Тип параметра дополнительно проверяет структурную совместимость generated DTO с Contracts.
 */
export async function successfulResponse<T>(
  pending: Promise<HttpResponse<T>>,
): Promise<RelayResponse<T>> {
  const value = await pending;
  if (!value.ok) {
    // Штатный transport отклоняет error envelope раньше; guard сохраняет безопасное сужение.
    throw new RelayApiError(value.error, 0);
  }
  return value;
}
