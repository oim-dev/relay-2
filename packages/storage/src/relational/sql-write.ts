import type { Database } from "bun:sqlite";
import { RelayError } from "@relay/contracts";
import type { SqlRow, SqlScalar } from "./columns.types";
import { relationalMessages } from "./relational.messages";

const utf8 = new TextEncoder();

/**
 * Передаёт lossless TEXT через UTF-8 bytes: sqlite3_bind_text16 поглощает начальный BOM.
 * Непарные UTF-16 units уже находятся в JSON-string carrier; остальные строки проходят без нормализации.
 */
function rowBinding(value: SqlScalar): SqlScalar | Uint8Array {
  return typeof value === "string" ? utf8.encode(value) : value;
}

/**
 * Возвращает BLOB-параметру тип TEXT; CAST сохраняет NULL без смены SQL-шаблона nullable text слота.
 */
function rowPlaceholder(value: SqlScalar): string {
  return typeof value === "number" ? "?" : "CAST(? AS TEXT)";
}

/**
 * Не допускает частичную предметную запись без внешней синхронной транзакции.
 */
export function requireRelationalTransaction(db: Database): void {
  if (!db.inTransaction) {
    throw new RelayError("TRANSACTION_REQUIRED", relationalMessages.transaction, 4);
  }
}

/**
 * Физические удаления и освобождение адресов доступны лишь проверенному техническому импорту.
 */
export function requireRelationalImport(db: Database): void {
  requireRelationalTransaction(db);
  const state = db
    .query<{ importing: number }, []>("SELECT importing FROM replication_state WHERE singleton=1")
    .get();
  if (state?.importing !== 1) {
    throw new RelayError("TRANSACTION_REQUIRED", relationalMessages.importRequired, 4);
  }
}

/**
 * Записывает заранее проверенную строку в таблицу закрытого каталога без собственного commit.
 * Имена таблицы и колонок являются константами схемы, не пользовательским вводом.
 */
export function insertSqlRow(db: Database, table: string, row: Readonly<SqlRow>): void {
  const columns = Object.keys(row);
  const values = columns.map((column) => row[column] ?? null);
  db.query(
    `INSERT INTO ${table}(${columns.join(",")}) VALUES(${values.map(rowPlaceholder).join(",")})`,
  ).run(...values.map(rowBinding));
}

/**
 * Выполняет exact upsert проверенной строки; неизменённый набор колонок не вызывает SQL UPDATE.
 * excludeUpdate сохраняет локально назначенную роль текущего ключа при обновлении metadata адреса.
 */
export function upsertSqlRow(
  db: Database,
  table: string,
  row: Readonly<SqlRow>,
  primaryKey: readonly string[],
  excludeUpdate: readonly string[] = [],
): void {
  const columns = Object.keys(row);
  const values = columns.map((column) => row[column] ?? null);
  const updated = columns.filter(
    (column) => !primaryKey.includes(column) && !excludeUpdate.includes(column),
  );
  db.query(
    `INSERT INTO ${table}(${columns.join(",")}) VALUES(${values.map(rowPlaceholder).join(",")})
    ON CONFLICT(${primaryKey.join(",")}) DO UPDATE SET ${updated.map((column) => `${column}=excluded.${column}`).join(",")}
    WHERE ${updated.map((column) => `${table}.${column} IS NOT excluded.${column}`).join(" OR ")}`,
  ).run(...values.map(rowBinding));
}
