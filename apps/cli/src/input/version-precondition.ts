import { CliUsageError } from "../errors/errors";
import { argumentMessages as messages } from "../locales/arguments";
import type { ArgumentValues } from "./arguments.types";
import type { ParsedVersionPrecondition, VersionFlagPair } from "./version-precondition.types";

export const ownerVersionFlags: VersionFlagPair = {
  revision: "if-revision",
  version: "expected-version",
};

/**
 * Читает обе формы предусловия из разобранных argv, сохраняя наличие каждого поля и точный токен.
 * Форму токена не интерпретирует; принадлежность владельцу и актуальность проверяет Core.
 */
export function readVersionPrecondition(
  values: ArgumentValues,
  flags: VersionFlagPair = ownerVersionFlags,
): ParsedVersionPrecondition {
  const revision = values[flags.revision];
  const version = values[flags.version];
  if (
    revision !== undefined &&
    (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1)
  ) {
    throw new CliUsageError(messages.integerRange(1, Number.MAX_SAFE_INTEGER));
  }
  if (version !== undefined && (typeof version !== "string" || !version.trim())) {
    throw new CliUsageError(messages.invalidVersionToken(flags.version));
  }
  return {
    ...(revision === undefined ? {} : { ifRevision: revision }),
    ...(version === undefined ? {} : { expectedVersion: version }),
  };
}

/**
 * Требует хотя бы одну форму до чтения stdin/файлов и открытия БД; одновременная передача допустима.
 */
export function requireVersionPrecondition(
  values: ArgumentValues,
  flags: VersionFlagPair = ownerVersionFlags,
): void {
  const parsed = readVersionPrecondition(values, flags);
  if (parsed.ifRevision === undefined && parsed.expectedVersion === undefined) {
    throw new CliUsageError(messages.versionPreconditionRequired(flags.revision, flags.version));
  }
}
