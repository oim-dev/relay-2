import type { Database } from "bun:sqlite";
import {
  RelayError,
  isPortableVersionParents,
  splitComponentRecord,
  type EntityRecord,
} from "@relay/contracts";
import { COMPONENTS_SCHEMA } from "../sqlite/components-schema";
import { migrateAddressComponent, readComponents, synchronizeComponents } from "./component-store";
import type { EntityRow } from "../entities/entity-queries.types";
import type { LegacyOwnerVersionRow } from "./component-migration.types";
import { portableEntity } from "../replication/portable-version";
import { componentStorageMessages } from "./component.messages";

/**
 * Собирает исходный raw owner из SQL-формы, не удаляя его прежние inline-коллекции.
 * Корневую JSON-форму защищает CHECK entities.data; предметное содержимое здесь не исправляется.
 */
function legacyOwnerRecord(row: EntityRow): EntityRecord {
  return {
    id: row.id,
    kind: row.kind,
    key: row.key,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    data: JSON.parse(row.data),
  };
}

/**
 * Проверяет все исходные hashes/parents v3 до нормализации и DDL под внешним migration lock.
 * Новый hash v4 не должен скрывать повреждённое основание. Версии v1/v2 ещё не имеют этих записей.
 * Читает owners потоково; отсутствие версии, неканонические parents и несовпадение дают CORRUPT_DATA.
 */
export function assertLegacyOwnerVersions(connection: Database): void {
  const rows = connection
    .query<LegacyOwnerVersionRow, []>(
      `SELECT e.*,NULL AS comments,v.version,v.parents_json FROM entities e
       LEFT JOIN replication_entity_versions v ON v.entity_id=e.id ORDER BY e.id`,
    )
    .iterate();
  for (const row of rows) {
    try {
      const parents: unknown = JSON.parse(row.parents_json ?? "null");
      if (
        row.version === null ||
        !isPortableVersionParents(parents) ||
        portableEntity(legacyOwnerRecord(row), parents).version !== row.version
      ) {
        throw new RelayError("CORRUPT_DATA", componentStorageMessages.legacyVersion, 1, {
          id: row.id,
        });
      }
    } catch (cause) {
      if (cause instanceof RelayError) {
        throw cause;
      }
      const failure = new RelayError("CORRUPT_DATA", componentStorageMessages.legacyVersion, 1, {
        id: row.id,
      });
      failure.cause = cause;
      throw failure;
    }
  }
}

/**
 * Переводит v3 primary owners/refs в v4 parts внутри транзакции владельца схемы.
 * Поколение, локальные ревизии, metadata, комментарии, квитанции и исходные outbox bytes неизменны.
 * Миграция не создаёт авторство частей и не подменяет повреждённые коллекции пустыми массивами.
 */
export function migrateComponents(connection: Database): void {
  const rows = connection
    .query<EntityRow, []>("SELECT *,NULL AS comments FROM entities ORDER BY id")
    .all();
  const addresses = connection
    .query<{ ref: string; entity_id: string }, []>(
      "SELECT ref,entity_id FROM entity_refs ORDER BY ref",
    )
    .all();
  const state = connection
    .query<{ importing: number }, []>("SELECT importing FROM replication_state WHERE singleton=1")
    .get();
  connection.exec(
    "UPDATE replication_state SET importing=1 WHERE singleton=1; DROP TABLE entity_refs;",
  );
  connection.exec(COMPONENTS_SCHEMA);
  for (const row of rows) {
    const record = legacyOwnerRecord(row);
    const layout = splitComponentRecord(record);
    synchronizeComponents(connection, layout, { migration: true });
    connection
      .query("UPDATE entities SET data=? WHERE id=?")
      .run(JSON.stringify(layout.record.data), record.id);
  }
  for (const address of addresses) {
    migrateAddressComponent(connection, address.entity_id, address.ref);
  }
  connection
    .query("UPDATE replication_state SET importing=? WHERE singleton=1")
    .run(state?.importing ?? 0);
}

/**
 * Включает первичные части в однократный baseline прямой v1/v2→v4 миграции.
 * Для существующей v3 очереди не вызывается: её первоначальный payload/digest остаются неизменными.
 */
export function enqueueComponentBaseline(connection: Database): void {
  const insert = connection.query(
    "INSERT INTO component_changes(owner_id,kind,id,before_json,after_json) VALUES(?,?,?,NULL,?)",
  );
  for (const part of readComponents(connection)) {
    insert.run(part.ownerId, part.kind, part.id, JSON.stringify(part));
  }
}
