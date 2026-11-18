import type { Database } from "bun:sqlite";
import { RelayError, type EntityRecord, type PortableComponent } from "@relay/contracts";
import { storageReplicationMessages } from "./replication.messages";
import { invalidateCurrentPublication } from "./replication-metadata";

/**
 * Читает режим текущей транзакции; отсутствие служебной строки считается повреждением базы.
 * Импорт сохраняет точное принятое состояние без повторного включения его в локальный outbox.
 */
export function isReplicationImport(connection: Database): boolean {
  const state = connection
    .query<{ importing: number }, []>("SELECT importing FROM replication_state WHERE singleton=1")
    .get();
  if (state === null) {
    throw new RelayError("DATABASE_INVALID", storageReplicationMessages.stateMissing);
  }
  return state.importing === 1;
}

/**
 * Запоминает исходную и последнюю raw-проекцию владельца в текущей транзакции.
 * Вызывается после успешной typed записи; savepoint откатывает очередь и поколение вместе с данными.
 * Прежний current proof снимается немедленно, включая capture внутри внешней транзакции.
 * Импорт владеет своим поколением и не создаёт локальной дельты.
 */
export function captureEntityChange(
  connection: Database,
  before: EntityRecord | null,
  after: EntityRecord,
): void {
  if (isReplicationImport(connection)) {
    return;
  }
  invalidateCurrentPublication(connection);
  connection
    .query(
      `INSERT INTO replication_entity_queue(id,before_json,after_json) VALUES(?,?,?)
       ON CONFLICT(id) DO UPDATE SET after_json=excluded.after_json`,
    )
    .run(after.id, before === null ? null : JSON.stringify(before), JSON.stringify(after));
  connection.exec("UPDATE project_state SET generation=generation+1 WHERE singleton=1");
}

/**
 * Сохраняет exact before/after части и упорядоченное событие для границы команды.
 * Назначение нового адреса входит в ту же транзакционную очередь. Импорт не создаёт echo.
 * Изменение части немедленно снимает current proof, не затрагивая accepted checkpoint.
 * Поколением агрегата владеет запись owner; отдельный комментарий имеет собственный механизм.
 */
export function captureComponentChange(
  connection: Database,
  before: PortableComponent | null,
  after: PortableComponent,
): void {
  if (isReplicationImport(connection)) {
    return;
  }
  invalidateCurrentPublication(connection);
  const beforeJson = before === null ? null : JSON.stringify(before);
  const afterJson = JSON.stringify(after);
  connection
    .query(
      `INSERT INTO component_changes(owner_id,kind,id,before_json,after_json) VALUES(?,?,?,?,?)
       ON CONFLICT(owner_id,kind,id) DO UPDATE SET after_json=excluded.after_json`,
    )
    .run(after.ownerId, after.kind, after.id, beforeJson, afterJson);
  connection
    .query(
      "INSERT INTO component_events(owner_id,kind,id,before_json,after_json) VALUES(?,?,?,?,?)",
    )
    .run(after.ownerId, after.kind, after.id, beforeJson, afterJson);
  if (after.kind === "address-assignment" && !after.deleted && before === null) {
    connection
      .query(
        `INSERT INTO replication_address_queue(ref,entity_id) VALUES(?,?)
         ON CONFLICT(ref) DO UPDATE SET entity_id=excluded.entity_id`,
      )
      .run(after.value.ref, after.ownerId);
  }
}
