import type { EntityKind } from "@relay/contracts";
import type { SqlRow } from "./columns.types";
import type { PortableTableMap } from "./rows.types";

/**
 * Однократные индексы полного переносимого набора для проверки типизированных FK и сборки DTO.
 */
export interface PortableRowIndex {
  /* Первичные строки каждой таблицы по JSON-кортежу её PK; local CAS исключён. */
  readonly tables: ReadonlyMap<keyof PortableTableMap, ReadonlyMap<string, Readonly<SqlRow>>>;
  /* Единственная предметная строка для каждого ID из реестра. */
  readonly entities: ReadonlyMap<string, Readonly<SqlRow>>;
  /* Неизменяемый вид владельца из object_ids. */
  readonly kinds: ReadonlyMap<string, EntityKind>;
  /* Единственное текущее действующее назначение ключа каждого владельца. */
  readonly keys: ReadonlyMap<string, string>;
  /* Обратная связь application -> board; повторные доски отвергаются. */
  readonly boards: ReadonlyMap<string, Readonly<SqlRow>>;
  /* Единственный действующий active run каждой сессии. */
  readonly runs: ReadonlyMap<string, string>;
  /* Реализации с действующим участием своего приложения. */
  readonly activeImplementations: ReadonlySet<string>;
}
