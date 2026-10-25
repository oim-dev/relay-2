import { validateActor, type CommandOptions, type ExpectedEntityAddress } from "@relay/contracts";
import { isObject } from "../../http/json-body.pipe";
import { invalidInput } from "../../http/query";

/**
 * Декодирует только HTTP-контекст записи; команды и их guards проверяет единый Core executor.
 * Actor, operationKey и expectedAddresses сохраняются дословно, без обновления по БД.
 */
export function writeContext(
  body: Readonly<Record<string, unknown>>,
  batch: boolean,
): CommandOptions {
  if (typeof body.actor !== "string") {
    invalidInput("actor");
  }
  validateActor(body.actor);
  if (typeof body.operationKey !== "string" || body.operationKey.trim().length === 0) {
    invalidInput("operationKey");
  }
  if (body.check !== undefined && (!batch || typeof body.check !== "boolean")) {
    invalidInput("check");
  }
  let expectedAddresses: ExpectedEntityAddress[] | undefined;
  if (body.expectedAddresses !== undefined) {
    if (!Array.isArray(body.expectedAddresses)) {
      invalidInput("expectedAddresses");
    }
    expectedAddresses = body.expectedAddresses.map((address: unknown) => {
      if (
        !isObject(address) ||
        typeof address.ref !== "string" ||
        typeof address.expectedId !== "string" ||
        Object.keys(address).some((key) => key !== "ref" && key !== "expectedId")
      ) {
        invalidInput("expectedAddresses");
      }
      return { ref: address.ref, expectedId: address.expectedId };
    });
  }
  return {
    actor: body.actor,
    operationKey: body.operationKey,
    ...(expectedAddresses === undefined ? {} : { expectedAddresses }),
    ...(body.check === undefined ? {} : { check: body.check }),
  };
}
