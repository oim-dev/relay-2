import type { ComponentKind, EntityKind } from "@relay/contracts";
import type { PortableTableMap } from "./rows.types";

/**
 * Описание физической первичной таблицы для чтения/экспорта и технических триггеров.
 */
export interface RelationalTableDescriptor {
  /* Постоянное SQL-имя таблицы; переносимые имена совпадают с ключами PortableTableMap. */
  readonly name: keyof PortableTableMap | "local_entity_revisions" | "local_comment_sequences";
  /* Колонки постоянного ключа в однозначном порядке для имени экспортируемого файла. */
  readonly primaryKey: readonly string[];
  /* false исключает локальные метаданные из portable codec. */
  readonly portable: boolean;
  /* Вид владельца; отсутствует у таблиц частей, отношений и технических метаданных. */
  readonly entityKind?: EntityKind;
  /* Вид совместимой части; отсутствует у остальных первичных таблиц. */
  readonly componentKind?: ComponentKind;
}
