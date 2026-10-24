import type { Database } from "bun:sqlite";
import {
  RelayError,
  type CommandCounter,
  type CommandObservation,
  type CommandSelector,
} from "@relay/contracts";
import type { KeyCounterRow } from "../entities/entity-queries.types";
import { entityMessages } from "../entities/entity.messages";
import { commandStorageMessages } from "./command.messages";

/**
 * Читает исходное сохранённое значение без резервирования номера; 0 обозначает отсутствие строки.
 */
export function readCommandCounter(connection: Database, prefix: string): number {
  return (
    connection
      .query<KeyCounterRow, [string]>("SELECT value FROM key_counters WHERE prefix=?")
      .get(prefix)?.value ?? 0
  );
}

/**
 * Предварительно выбирает ключ без записи, пропуская занятые ID/ключи/алиасы, виртуальные адреса
 * выбранного вида и собственные резервы. Число попыток ограничено реальным занятым префиксом.
 */
export function previewCommandKey(
  connection: Database,
  selector: Extract<CommandSelector, { kind: "key" }>,
): Extract<CommandObservation, { kind: "key" }> {
  const { prefix, after, excluded, entityKind } = selector;
  if (!prefix || prefix.trim() !== prefix || /\s|\p{Cc}|:/u.test(prefix)) {
    throw new RelayError("VALIDATION_ERROR", entityMessages.invalidPrefix, 2);
  }
  if (!Number.isSafeInteger(after) || after < 0) {
    throw new RelayError("VALIDATION_ERROR", commandStorageMessages.invalidCounter, 2);
  }
  const before = readCommandCounter(connection, prefix);
  const occupied = new Set(excluded);
  // Верхняя граница заменяет завершающий '-' на следующий ASCII-символ и не использует LIKE.
  const lower = `${prefix}-`;
  const upper = `${prefix}.`;
  const rows = connection
    .query<{ ref: string }, [string, string, string, string, string, string, string, string]>(
      `
    SELECT ref FROM entity_refs WHERE ref>=? AND ref<?
    UNION SELECT json_extract(data,'$.slug') AS ref FROM entities
      WHERE kind=? AND json_type(data,'$.slug')='text' AND ref>=? AND ref<?
    UNION SELECT json_extract(data,'$.prefix') AS ref FROM entities
      WHERE kind=? AND json_type(data,'$.prefix')='text' AND ref>=? AND ref<?
  `,
    )
    .all(lower, upper, entityKind, lower, upper, entityKind, lower, upper);
  for (const { ref } of rows) {
    occupied.add(ref);
  }
  let value = Math.max(before, after);
  for (let attempt = 0; attempt <= occupied.size; attempt++) {
    if (value >= Number.MAX_SAFE_INTEGER) {
      throw new RelayError("CONFLICT", commandStorageMessages.keyExhausted, 4, { prefix });
    }
    value++;
    const key = `${prefix}-${value}`;
    if (!occupied.has(key)) {
      return { kind: "key", before, value, key };
    }
  }
  throw new RelayError("STORAGE_ERROR", commandStorageMessages.keyExhausted, 1, { prefix });
}

/**
 * Применяет каждый счётчик ровно before→after под внешним замком писателя.
 * Несовпадение или повтор префикса откатывает весь план; поиск нового ключа здесь запрещён.
 */
export function applyCommandCounters(
  connection: Database,
  counters: readonly CommandCounter[],
): void {
  const seen = new Set<string>();
  for (const counter of counters) {
    const { prefix, before, after } = counter;
    if (
      seen.has(prefix) ||
      !Number.isSafeInteger(before) ||
      before < 0 ||
      !Number.isSafeInteger(after) ||
      after <= before
    ) {
      throw new RelayError("VALIDATION_ERROR", commandStorageMessages.invalidCounter, 2, {
        prefix,
      });
    }
    seen.add(prefix);
    const row =
      before === 0
        ? connection
            .query(
              "INSERT INTO key_counters(prefix,value) VALUES(?,?) ON CONFLICT(prefix) DO NOTHING RETURNING prefix",
            )
            .get(prefix, after)
        : connection
            .query("UPDATE key_counters SET value=? WHERE prefix=? AND value=? RETURNING prefix")
            .get(after, prefix, before);
    if (row === null) {
      throw new RelayError("COMMAND_CONTEXT_CHANGED", commandStorageMessages.contextChanged, 4, {
        prefix,
        expected: before,
        actual: readCommandCounter(connection, prefix),
      });
    }
  }
}
