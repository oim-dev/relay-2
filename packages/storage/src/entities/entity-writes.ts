/**
 * SQL-запись сущностей и независимого журнала комментариев.
 * SQL-операции требуют активной транзакции владельца ProjectDatabase и не делают commit.
 */
import type { Database } from "bun:sqlite";
import {
  RelayError,
  splitComponentRecord,
  type EntityRecord,
  type TaskComment,
} from "@relay/contracts";
import { getEntityIdentity, getRawEntity } from "./entity-queries";
import type { EntityRevision, KeyCounterRow } from "./entity-queries.types";
import { entityMessages } from "./entity.messages";
import { synchronizeComponents } from "../components/component-store";
import type { ComponentWriteOptions } from "../components/component-store.types";
import { assertEntitySqlText, assertSqlText } from "./entity-sql-text";
import { insertRawEntity, updateRawEntity } from "../relational/entity-store";
import { captureEntityChange, isReplicationImport } from "../replication/replication-capture";
import { ensureEntityAddresses } from "../components/address-assignments";
import { assignCurrentKey } from "../relational/key-store";
import { encodeText } from "../relational/columns";
import { insertSqlRow } from "../relational/sql-write";
import type { EntityUpdateOptions } from "./entity-writes.types";

/**
 * Вставляет typed owner и primary parts, сохраняя поколение и очередь в той же транзакции.
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
  insertRawEntity(connection, layout.record, { keyMode: "defer" });
  if (!isReplicationImport(connection)) {
    ensureEntityAddresses(connection, entity, options);
    assignCurrentKey(connection, entity.id, entity.key, { create: false });
    synchronizeComponents(connection, layout, options);
  }
  captureEntityChange(connection, null, layout.record);
}

/**
 * Выполняет CAS owner и синхронизирует его parts, возвращая признак совпадения ревизии.
 * Только изменённые части меняют версии; комментарии не затрагиваются. В importing parts пишет import owner.
 * Exact before команды сохраняет основание производных связей, даже если соседний эффект уже изменил их JOIN.
 */
export function updateEntity(
  connection: Database,
  entity: EntityRecord,
  expectedRevision: number,
  options: EntityUpdateOptions = {},
): boolean {
  assertEntitySqlText(entity);
  const layout = splitComponentRecord(entity);
  if (isReplicationImport(connection)) {
    return updateRawEntity(connection, layout.record, expectedRevision, { keyMode: "defer" });
  }
  const before =
    options.before === undefined
      ? getRawEntity(connection, entity.id)
      : splitComponentRecord(options.before).record;
  if (before !== undefined && before.id !== entity.id) {
    throw new RelayError("VALIDATION_ERROR", entityMessages.invalidBefore, 2);
  }
  if (before === undefined || before.revision !== expectedRevision) {
    return false;
  }
  if (!updateRawEntity(connection, layout.record, expectedRevision, { keyMode: "defer" })) {
    return false;
  }
  ensureEntityAddresses(connection, entity, options);
  assignCurrentKey(connection, entity.id, entity.key, { create: false });
  synchronizeComponents(connection, layout, options);
  captureEntityChange(connection, before, layout.record);
  return true;
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
 * Добавляет переносимую строку комментария и отдельный локальный порядок в одной транзакции.
 * Уникальность ID, вид владельца и прирост поколения обеспечиваются SQL, ревизия задачи не меняется.
 * afterId задаёт точного предшественника импорта; undefined выбирает последнюю локальную запись задачи.
 * Общий UTF-8 binding сохраняет начальный BOM; непарные UTF-16 units передаются через scalar carrier.
 */
export function appendComment(
  connection: Database,
  taskId: string,
  comment: TaskComment,
  afterId?: string | null,
): void {
  assertSqlText(taskId, "taskId");
  for (const field of ["id", "createdAt", "createdBy"] as const) {
    assertSqlText(comment[field], `comment.${field}`);
  }
  const title = commentField(comment, "title");
  const body = commentField(comment, "body");
  const titleRow = encodeText(title, "title");
  const bodyRow = encodeText(body, "body");
  const after =
    afterId === undefined
      ? (connection
          .query<{ id: string }, [string]>(
            `SELECT c.id FROM task_comments c
             JOIN local_comment_sequences s ON s.comment_id=c.id
             WHERE c.task_id=? ORDER BY s.sequence DESC LIMIT 1`,
          )
          .get(taskId)?.id ?? null)
      : afterId;
  if (after !== null) {
    assertSqlText(after, "comment.afterId");
  }
  insertSqlRow(connection, "task_comments", {
    id: comment.id,
    task_id: taskId,
    ...titleRow,
    ...bodyRow,
    created_at: comment.createdAt,
    created_by: comment.createdBy,
    after_id: after,
  });
  connection
    .query(
      `INSERT INTO local_comment_sequences(comment_id,sequence)
       SELECT ?,coalesce(max(sequence),0)+1 FROM local_comment_sequences`,
    )
    .run(comment.id);
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
