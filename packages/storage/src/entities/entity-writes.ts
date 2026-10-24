/**
 * SQL-запись сущностей и независимого журнала комментариев.
 * SQL-операции требуют активной транзакции владельца ProjectDatabase и не делают commit.
 */
import type { Database } from "bun:sqlite";
import {
  RelayError,
  isPortableIdentityText,
  splitComponentRecord,
  type EntityRecord,
  type TaskComment,
} from "@relay/contracts";
import { getEntityIdentity } from "./entity-queries";
import type { EntityRevision, KeyCounterRow } from "./entity-queries.types";
import { entityMessages } from "./entity.messages";
import { synchronizeComponents } from "../components/component-store";
import { withComponentAllocation } from "../components/component-allocation";
import type { ComponentWriteOptions } from "../components/component-store.types";
import { assertEntitySqlText, assertSqlText } from "./entity-sql-text";

/**
 * Проверяет техническое suppression импорта: raw owner не должен регенерировать primary parts.
 */
function importingComponents(connection: Database): boolean {
  return (
    connection
      .query<{ importing: number }, []>("SELECT importing FROM replication_state WHERE singleton=1")
      .get()?.importing === 1
  );
}

/**
 * Вставляет raw owner и primary parts; алиасы и поколение создаются триггерами той же транзакции.
 * Начальные комментарии запрещены, кроме пустой проекции: журнал пополняется отдельной операцией.
 */
export function insertEntity(
  connection: Database,
  entity: EntityRecord,
  options: ComponentWriteOptions = {},
): void {
  assertEntitySqlText(entity);
  if (
    entity.kind === "task" &&
    Object.hasOwn(entity.data, "comments") &&
    (!Array.isArray(entity.data.comments) || entity.data.comments.length !== 0)
  ) {
    throw new RelayError("VALIDATION_ERROR", entityMessages.commentRequiresAppend, 2);
  }
  const layout = splitComponentRecord(entity);
  withComponentAllocation(connection, options, () => {
    connection
      .query(
        `INSERT INTO entities(id, kind, key, revision, created_at, updated_at, created_by, updated_by, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entity.id,
        entity.kind,
        entity.key,
        entity.revision,
        entity.createdAt,
        entity.updatedAt,
        entity.createdBy,
        entity.updatedBy,
        JSON.stringify(layout.record.data),
      );
    if (!importingComponents(connection)) {
      synchronizeComponents(connection, layout, options);
    }
  });
}

/**
 * Выполняет CAS owner и синхронизирует его parts, возвращая признак совпадения ревизии.
 * Только изменённые части меняют версии; комментарии не затрагиваются. В importing parts пишет import owner.
 */
export function updateEntity(
  connection: Database,
  entity: EntityRecord,
  expectedRevision: number,
  options: ComponentWriteOptions = {},
): boolean {
  assertEntitySqlText(entity);
  const layout = splitComponentRecord(entity);
  return withComponentAllocation(connection, options, () => {
    // run().changes учитывает триггеры; RETURNING подтверждает изменение самой строки CAS.
    const result = connection
      .query(
        `UPDATE entities SET kind = ?, key = ?, revision = ?, created_at = ?, updated_at = ?,
         created_by = ?, updated_by = ?, data = ? WHERE id = ? AND revision = ? RETURNING id`,
      )
      .get(
        entity.kind,
        entity.key,
        entity.revision,
        entity.createdAt,
        entity.updatedAt,
        entity.createdBy,
        entity.updatedBy,
        JSON.stringify(layout.record.data),
        entity.id,
        expectedRevision,
      );
    if (result !== null && !importingComponents(connection)) {
      synchronizeComponents(connection, layout, options);
    }
    return result !== null;
  });
}

/**
 * Резервирует следующий свободный ключ, пропуская ID, текущие ключи и сохранённые алиасы.
 * Счётчик и проверка общего пространства ссылок должны удерживать одну блокировку писателя.
 */
export function nextAvailableKey(connection: Database, prefix: string): string {
  assertSqlText(prefix, "prefix");
  while (true) {
    const counter = connection
      .query<KeyCounterRow, [string]>(
        `INSERT INTO key_counters(prefix, value) VALUES (?, 1)
         ON CONFLICT(prefix) DO UPDATE SET value = value + 1 RETURNING value`,
      )
      .get(prefix);
    if (!counter) {
      throw new RelayError("STORAGE_ERROR", entityMessages.counterMissing);
    }
    const key = `${prefix}-${counter.value}`;
    if (!getEntityIdentity(connection, key)) {
      return key;
    }
  }
}

/**
 * Проверяет строковое поле внешнего комментария без предметных ограничений Core.
 */
function commentField(comment: Record<string, unknown>, field: keyof TaskComment): string {
  const value = comment[field];
  if (typeof value !== "string") {
    throw new RelayError("VALIDATION_ERROR", entityMessages.invalidCommentField(field), 2);
  }
  return value;
}

/**
 * Декодирует техническую форму комментария до входа в транзакцию, игнорируя лишние поля.
 * Семантику автора, времени и содержания проверяет Core; здесь обязательны пять строк.
 */
export function decodeTaskComment(comment: Record<string, unknown>): TaskComment {
  return {
    id: commentField(comment, "id"),
    title: commentField(comment, "title"),
    body: commentField(comment, "body"),
    createdAt: commentField(comment, "createdAt"),
    createdBy: commentField(comment, "createdBy"),
  };
}

/**
 * Добавляет комментарий в append-only журнал с порядком по SQLite sequence.
 * Уникальность ID, вид владельца и прирост поколения обеспечиваются SQL, ревизия задачи не меняется.
 */
export function appendComment(connection: Database, taskId: string, comment: TaskComment): void {
  assertSqlText(taskId, "taskId");
  for (const field of ["id", "createdAt", "createdBy"] as const) {
    assertSqlText(comment[field], `comment.${field}`);
  }
  const title = commentField(comment, "title");
  const body = commentField(comment, "body");
  const titleJson = isPortableIdentityText(title) ? null : JSON.stringify(title);
  const bodyJson = isPortableIdentityText(body) ? null : JSON.stringify(body);
  const encoding = (titleJson === null ? 0 : 1) | (bodyJson === null ? 0 : 2);
  connection
    .query(
      `INSERT INTO task_comments(id, task_id, title, body, created_at, created_by, text_encoding)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      comment.id,
      taskId,
      titleJson === null ? title : "",
      bodyJson === null ? body : "",
      comment.createdAt,
      comment.createdBy,
      encoding,
    );
  if (titleJson !== null || bodyJson !== null) {
    connection
      .query("INSERT INTO replication_comment_text(comment_id,title_json,body_json) VALUES(?,?,?)")
      .run(comment.id, titleJson, bodyJson);
  }
}

/**
 * Формирует отказ CAS по фактической ревизии содержания сущности.
 */
export function revisionConflict(entity: EntityRevision, expectedRevision: number): RelayError {
  return new RelayError("REVISION_CONFLICT", entityMessages.revisionConflict, 4, {
    id: entity.id,
    expectedRevision,
    actualRevision: entity.revision,
  });
}
