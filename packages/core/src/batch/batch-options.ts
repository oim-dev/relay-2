import { validateActor, type CommandOptions, type ExpectedEntityAddress } from "@relay/contracts";
import { parseEntityReference } from "../entities/entity-addresses";
import { batchFields, batchText, invalidBatch } from "./batch-input";
import { batchMessages } from "./batch.messages";
import type { CapturedCommandAddresses, PreparedCommandOptions } from "./batch-options.types";

/**
 * Снимает копию до await, но не нарушает ошибкой копирования приоритет сохранённой receipt.
 */
function captureCommandAddresses(value: unknown): CapturedCommandAddresses {
  try {
    return { kind: "captured", value: structuredClone(value) };
  } catch {
    return { kind: "uncloneable" };
  }
}

/**
 * Фиксирует автора, режим, ключ и адресные ожидания до любого асинхронного I/O.
 */
export function prepareCommandOptions(
  options: CommandOptions,
  requireKey: boolean,
): PreparedCommandOptions {
  batchFields(options, ["actor", "operationKey", "check", "expectedAddresses"], "options");
  const actor = validateActor(options.actor);
  const requestedCheck = options.check;
  if (requestedCheck !== undefined && typeof requestedCheck !== "boolean") {
    invalidBatch(batchMessages.check, "options.check");
  }
  const suppliedKey = options.operationKey;
  const operationKey =
    suppliedKey === undefined ? null : batchText(suppliedKey, "options.operationKey");
  const check = requestedCheck === true;
  if (requireKey && !check && operationKey === null) {
    invalidBatch(batchMessages.operationKey, "options.operationKey");
  }
  return {
    actor,
    operationKey,
    check,
    addresses: captureCommandAddresses(options.expectedAddresses),
  };
}

/**
 * Проверяет скопированные адресные guards после отсутствия готовой первоначальной квитанции.
 */
export function parseCommandAddresses(
  captured: CapturedCommandAddresses,
): readonly ExpectedEntityAddress[] {
  if (captured.kind === "uncloneable") {
    invalidBatch(batchMessages.reference, "options.expectedAddresses");
  }
  const value = captured.value;
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    invalidBatch(batchMessages.reference, "options.expectedAddresses");
  }
  return value.map((entry: unknown) => {
    const fields = batchFields(entry, ["ref", "expectedId"], "options.expectedAddresses");
    const ref = batchText(fields.ref, "options.expectedAddresses.ref");
    parseEntityReference(ref);
    return {
      ref,
      expectedId: batchText(fields.expectedId, "options.expectedAddresses.expectedId"),
    };
  });
}
