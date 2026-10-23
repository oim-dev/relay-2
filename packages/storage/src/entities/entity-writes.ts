/**
 * SQL-запись сущностей и независимого журнала комментариев.
 * SQL-операции требуют активной транзакции владельца ProjectDatabase и не делают commit.
 */
import type { Database } from "bun:sqlite";
import { RelayError, type EntityRecord, type TaskComment } from "@relay/contracts";
import { getEntityIdentity } from "./entity-queries";
import type { EntityRevision, KeyCounterRow } from "./entity-queries.types";
import { entityMessages } from "./entity.messages";

/**
 * Сериализует содержание без проекции комментариев задачи.
 * Снимок редактора может быть старше журнала: CAS содержания никогда не заменяет комментарии.
 */
function entityPayload(entity: EntityRecord): string {
  if (entity.kind !== "task") {
    return JSON.stringify(entity.data);
  }
  const data = { ...entity.data };
  delete data.comments;
  return JSON.stringify(data);
}

/**
 * Вставляет одну сущность; алиасы и поколение создаются триггерами в той же транзакции.
 * Начальные комментарии запрещены, кроме пустой проекции: журнал пополняется отдельной операцией.
 */
export function insertEntity(connection: Database, entity: EntityRecord): void {
  if (
    entity.kind === "task" &&
    Object.hasOwn(entity.data, "comments") &&
    (!Array.isArray(entity.data.comments) || entity.data.comments.length !== 0)
  ) {
    throw new RelayError("VALIDATION_ERROR", entityMessages.commentRequiresAppend, 2);
  }
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
      entityPayload(entity),
    );
}

/**
 * Выполняет CAS одной строки содержания и возвращает признак совпадения ревизии.
 * SQL проверяет неизменяемые поля и прирост ревизии на единицу; комментарии не затрагиваются.
 */
export function updateEntity(
  connection: Database,
  entity: EntityRecord,
  expectedRevision: number,
): boolean {
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
      entityPayload(entity),
      entity.id,
      expectedRevision,
    );
  return result !== null;
}

/**
 * Резервирует следующий свободный ключ, пропуская ID, текущие ключи и сохранённые алиасы.
 * Счётчик и проверка общего пространства ссылок должны удерживать одну блокировку писателя.
 */
export function nextAvailableKey(connection: Database, prefix: string): string {
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
  connection
    .query(
      `INSERT INTO task_comments(id, task_id, title, body, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(comment.id, taskId, comment.title, comment.body, comment.createdAt, comment.createdBy);
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
