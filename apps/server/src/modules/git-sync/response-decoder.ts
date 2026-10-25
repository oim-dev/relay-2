import Ajv, { type ValidateFunction } from "ajv";
import { RelayError, type HttpReadResults, type HttpGitSyncStatus } from "@relay/contracts";
import schema from "../../http/generated-schemas.json";
import { isObject } from "../../http/json-body.pipe";
import { httpMessages } from "../../http/http.messages";

const validator = new Ajv({ strict: false, allErrors: false });
validator.addSchema(schema, "relay-http");
const decoders = new Map<keyof HttpReadResults, ValidateFunction<unknown>>();

/**
 * Проверяет unknown process output по generated Contracts schema до объявления DTO.
 * Кеш хранит только чистые validators, без Runtime конфигурации или пользовательских данных.
 */
export function decodeResult<K extends keyof HttpReadResults>(
  operation: K,
  value: unknown,
): HttpReadResults[K] {
  let validate = decoders.get(operation);
  if (validate === undefined) {
    validate = validator.compile({
      $ref: `relay-http#/definitions/HttpApiSchemas/properties/${operation}`,
    });
    decoders.set(operation, validate);
  }
  if (!validate({ ok: true, data: value })) {
    throw new RelayError("GIT_SYNC_INVALID_RESPONSE", httpMessages.gitResponse);
  }
  // Schema сгенерирована из HttpReadResults[K] и проверила полный DTO вместе с union.
  return value as HttpReadResults[K];
}

/**
 * Требует реальную обязательную секцию Runtime вместо подстановки пустого объекта.
 */
function section(value: unknown): Record<string, unknown> {
  if (!isObject(value)) {
    throw new RelayError("GIT_SYNC_INVALID_RESPONSE", httpMessages.gitResponse);
  }
  return value;
}

/**
 * Проверяет счётчик без преобразования undefined/null в ноль.
 */
function count(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Выбирает только используемые поля настоящего cached Runtime status.
 * Nullable значения и freshness сохраняются; отсутствие обязательного поля отвергает schema.
 */
export function cachedStatus(value: unknown): HttpGitSyncStatus {
  const input = section(value);
  const worker = section(input.worker);
  const pending = section(input.pending);
  const conflicts = section(input.conflicts);
  const freshness = section(input.freshness);
  const error = input.error === null ? null : section(input.error);
  if (
    typeof input.connected !== "boolean" ||
    !["manual", "auto"].includes(String(input.mode)) ||
    typeof input.phase !== "string" ||
    input.phase.length === 0 ||
    !["running", "stopped"].includes(String(worker.desired)) ||
    typeof worker.responsive !== "boolean" ||
    !count(pending.changesets) ||
    (pending.unexported !== null && !count(pending.unexported)) ||
    !count(conflicts.count) ||
    typeof freshness.known !== "boolean"
  ) {
    throw new RelayError("GIT_SYNC_INVALID_RESPONSE", httpMessages.gitResponse);
  }
  return decodeResult("gitSyncStatus", {
    connected: input.connected,
    mode: input.mode,
    phase: input.phase,
    worker: { desired: worker.desired, actual: worker.actual, responsive: worker.responsive },
    pending: { changesets: pending.changesets, unexported: pending.unexported },
    conflicts: { count: conflicts.count, freshness: conflicts.freshness, asOf: conflicts.asOf },
    lastSuccess: input.lastSuccess,
    error:
      error === null
        ? null
        : {
            code: error.code,
            message: error.message,
            ...(error.details === undefined ? {} : { details: error.details }),
          },
    freshness: { known: freshness.known, asOf: freshness.asOf, remoteHead: freshness.remoteHead },
  });
}
