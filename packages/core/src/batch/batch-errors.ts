import { RelayError } from "@relay/contracts";
import { batchMessages } from "./batch.messages";

/**
 * Дополняет отказ координатами шага, сохраняя предметный код, exitCode и исходную причину.
 * Технический путь SQLite не подменяет путь поля пакета; непредвиденный отказ остаётся ошибкой.
 */
export function locateBatchError(
  error: unknown,
  index: number,
  op: string,
  fallback = "input",
): RelayError {
  const cause =
    error instanceof RelayError
      ? error
      : new RelayError("BATCH_EXECUTION_FAILED", batchMessages.unexpected);
  let field = cause.code === "REVISION_CONFLICT" ? "ifRevision" : fallback;
  if (field === "input" && typeof cause.details?.field === "string") {
    field = `input.${cause.details.field}`;
  }
  const path =
    typeof cause.details?.path === "string" && cause.details.path.startsWith("operations[")
      ? cause.details.path
      : `operations[${index}].${field}`;
  const failure = new RelayError(cause.code, cause.message, cause.exitCode, {
    ...cause.details,
    index,
    op,
    path,
  });
  failure.cause = error;
  return failure;
}
