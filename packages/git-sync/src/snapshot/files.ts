import { RelayError, type PortableProjectSnapshot } from "@relay/contracts";
import { RELATIONAL_TABLES, portableRowsToSnapshot, snapshotToPortableRows } from "@relay/storage";
import type { GitFiles } from "../transport/repository.types";
import { invalidSnapshot, keys, object, parseJson, prettyJson } from "./json";
import { decodeManifest, encodeManifest, rowFilePath, rowFileTable } from "./layout";
import { snapshotMessages } from "./snapshot.messages";

const portableTables = new Map<string, (typeof RELATIONAL_TABLES)[number]>(
  RELATIONAL_TABLES.filter((table) => table.portable).map((table) => [table.name, table]),
);

/**
 * Выпускает layout 3: одна папка на переносимую SQL-таблицу, один JSON на её строку.
 * Storage владеет разложением и закрытой схемой; порядок файлов и JSON не зависит от порядка входа.
 */
export function encodeSnapshot(snapshot: PortableProjectSnapshot): Map<string, Uint8Array> {
  if (
    snapshot.formatVersion !== 1 ||
    snapshot.modelVersion !== 2 ||
    snapshot.components === undefined ||
    snapshot.publication === undefined
  ) {
    throw new RelayError("GIT_FORMAT_INCOMPATIBLE", snapshotMessages.version, 4);
  }
  const rows = convertStorageRows(() => snapshotToPortableRows(snapshot));
  keys(object(rows), ["projectId", "tables"]);
  if (rows.projectId !== snapshot.projectId) {
    invalidSnapshot();
  }
  const tables: Readonly<Record<string, readonly unknown[]>> = rows.tables;
  const files = new Map<string, Uint8Array>([
    ["manifest.json", encodeManifest(snapshot.projectId)],
  ]);
  for (const [name, entries] of Object.entries(tables)) {
    const table = requirePortableTable(name);
    for (const entry of entries) {
      const row = object(entry);
      const path = rowFilePath(name, primaryKey(row, table.primaryKey));
      if (files.has(path)) {
        invalidSnapshot();
      }
      files.set(path, Buffer.from(prettyJson(row), "utf8"));
    }
  }
  return new Map([...files].sort(([left], [right]) => compareText(left, right)));
}

/**
 * Читает только табличный layout 3 без filesystem и возвращает логическую проекцию для Core.
 * Пути и PK проверяются здесь, полная закрытая форма строк — Storage, предметные правила — Core.
 * Входная карта и её bytes остаются собственностью вызывающего и не изменяются.
 */
export function decodeSnapshotData(files: GitFiles, expectedProjectId?: string): unknown {
  const manifest = files.get("manifest.json");
  if (manifest === undefined) {
    return invalidSnapshot();
  }
  const projectId = decodeManifest(manifest, expectedProjectId);
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const name of portableTables.keys()) {
    tables[name] = [];
  }
  for (const [path, bytes] of files) {
    if (path === "manifest.json") {
      continue;
    }
    const name = rowFileTable(path);
    const table = requirePortableTable(name);
    const row = object(parseJson(bytes));
    if (path !== rowFilePath(name, primaryKey(row, table.primaryKey))) {
      invalidSnapshot();
    }
    const entries = tables[name];
    if (entries === undefined) {
      return invalidSnapshot();
    }
    entries.push(row);
  }
  const input: unknown = { projectId, tables };
  const snapshot = convertStorageRows(() => portableRowsToSnapshot(input));
  if (snapshot.projectId !== projectId) {
    invalidSnapshot();
  }
  return snapshot;
}

/**
 * Требует переносимую таблицу закрытого каталога; локальные SQL-таблицы не становятся файлами Git.
 */
function requirePortableTable(name: string): (typeof RELATIONAL_TABLES)[number] {
  const table = portableTables.get(name);
  if (table === undefined) {
    return invalidSnapshot();
  }
  return table;
}

/**
 * Извлекает кортеж именно объявленных PK-колонок без подмены отсутствующего поля пустым значением.
 * Содержание остальных колонок и предметную допустимость ключа проверяет общий codec Storage.
 */
function primaryKey(
  row: Readonly<Record<string, unknown>>,
  columns: readonly string[],
): (string | number)[] {
  return columns.map((column) => {
    const value = row[column];
    if (typeof value !== "string" && !(typeof value === "number" && Number.isSafeInteger(value))) {
      return invalidSnapshot();
    }
    return value;
  });
}

/**
 * Переводит отказ формы Storage в диагностику Git, сохраняя исходную причину.
 * Неожиданные ошибки реализации сохраняют свой тип и не маскируются повреждённым снимком.
 */
function convertStorageRows<T>(convert: () => T): T {
  try {
    return convert();
  } catch (error) {
    if (error instanceof RelayError && error.code === "CORRUPT_DATA") {
      return invalidSnapshot(error);
    }
    throw error;
  }
}

/**
 * Сравнивает канонические пути по UTF-16 code units независимо от locale/ICU хоста.
 */
function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
