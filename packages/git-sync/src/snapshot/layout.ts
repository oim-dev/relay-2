import { RelayError, isPortableIdentityText } from "@relay/contracts";
import { createHash } from "node:crypto";
import { canonicalJson, invalidSnapshot, keys, object, parseJson, prettyJson, text } from "./json";
import { snapshotMessages } from "./snapshot.messages";

/**
 * Выпускает единственный manifest табличного layout; версии логической проекции независимы от SQL.
 */
export function encodeManifest(projectId: string): Uint8Array {
  requireProjectId(projectId);
  return Buffer.from(
    prettyJson({ layoutVersion: 3, formatVersion: 1, modelVersion: 2, projectId }),
    "utf8",
  );
}

/**
 * Проверяет закрытый manifest и возвращает постоянный ID проекта до чтения строк таблиц.
 * Прежние layout 1/2 несовместимы; ожидаемый чужой projectId имеет отдельную диагностику.
 */
export function decodeManifest(bytes: Uint8Array, expectedProjectId?: string): string {
  const manifest = object(parseJson(bytes));
  if (manifest.layoutVersion !== 3 || manifest.formatVersion !== 1 || manifest.modelVersion !== 2) {
    throw new RelayError("GIT_FORMAT_INCOMPATIBLE", snapshotMessages.version, 4);
  }
  keys(manifest, ["layoutVersion", "formatVersion", "modelVersion", "projectId"]);
  const projectId = text(manifest.projectId);
  requireProjectId(projectId);
  if (expectedProjectId !== undefined && projectId !== expectedProjectId) {
    throw new RelayError("GIT_PROJECT_MISMATCH", snapshotMessages.project, 4);
  }
  return projectId;
}

/**
 * Адресует строку по SHA-256 канонического упорядоченного кортежа её первичного ключа.
 * Типы и границы PK проверяет Storage; длина имени и регистр не зависят от его содержания.
 */
export function rowFilePath(table: string, primaryKey: readonly (string | number)[]): string {
  if (/^[a-z][a-z0-9_]*$/.exec(table)?.[0] !== table || primaryKey.length === 0) {
    return invalidSnapshot();
  }
  const digest = createHash("sha256").update(canonicalJson(primaryKey), "utf8").digest("hex");
  return `${table}/${digest}.json`;
}

/**
 * Разбирает только канонический относительный путь строки; наличие таблицы проверяет каталог Storage.
 * Вложенные файлы, Windows-разделители, другой регистр digest и обход каталогов недопустимы.
 */
export function rowFileTable(path: string): string {
  const match = /^([a-z][a-z0-9_]*)\/[a-f0-9]{64}\.json$/.exec(path);
  if (!match?.[1] || match[0] !== path) {
    return invalidSnapshot();
  }
  return match[1];
}

/**
 * Требует непустую переносимую идентичность без нормализации Unicode.
 */
function requireProjectId(projectId: string): void {
  if (projectId.length === 0 || !isPortableIdentityText(projectId)) {
    invalidSnapshot();
  }
}
