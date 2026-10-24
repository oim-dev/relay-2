import type { ExpectedEntityAddress } from "@relay/contracts";
import { CliUsageError } from "../errors/errors";
import { argumentMessages } from "../locales/arguments";

/**
 * Проверяет только форму guard, сохраняя исходные ref/ID пользователя без разрешения по текущей БД.
 * Совпадение адреса проверяет Core в том же execution context, что и изменения.
 */
export function expectedAddressValues(value: unknown): readonly ExpectedEntityAddress[] {
  if (!Array.isArray(value)) {
    throw new CliUsageError(argumentMessages.expectedAddressesShape);
  }
  return value.map((item: unknown) => {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      !("ref" in item) ||
      typeof item.ref !== "string" ||
      !item.ref.trim() ||
      !("expectedId" in item) ||
      typeof item.expectedId !== "string" ||
      !item.expectedId.trim() ||
      Object.keys(item).some((key) => key !== "ref" && key !== "expectedId")
    ) {
      throw new CliUsageError(argumentMessages.expectedAddressesShape);
    }
    return { ref: item.ref, expectedId: item.expectedId };
  });
}

/**
 * Разбирает inline JSON глобального --expected-addresses без чтения stdin и без выбора проекта.
 */
export function parseExpectedAddresses(text: string): readonly ExpectedEntityAddress[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new CliUsageError(argumentMessages.expectedAddressesShape, "INVALID_JSON", { cause });
  }
  return expectedAddressValues(value);
}
