import type { Database } from "bun:sqlite";
import {
  RelayError,
  type CommandCommitFacts,
  type CommandCommitPlan,
  type EntityRecord,
  type TaskComment,
} from "@relay/contracts";
import type { ProjectGenerationRow } from "../database/project-database.types";
import { TASK_COMMENT_JSON, TASK_COMMENT_SOURCE } from "../entities/comment-text";
import { getEntities } from "../entities/entity-queries";
import { decodeTaskComment } from "../entities/entity-writes";
import type { CommandCommentRow } from "./command-selection.types";
import { commandStorageMessages } from "./command.messages";

/**
 * Читает предметное поколение удерживаемого снимка, независимое от технической revision anchor.
 */
export function readCommandGeneration(connection: Database): number {
  const state = connection
    .query<ProjectGenerationRow, []>("SELECT generation FROM project_state WHERE singleton=1")
    .get();
  if (state === null) {
    throw new RelayError("DATABASE_INVALID", commandStorageMessages.generationMissing);
  }
  return state.generation;
}

/**
 * Разрешает дочитывать только владельцев независимых append-эффектов.
 * Проверяется до записи: актуальная карточка не должна подменять подготовленный content-effect/CAS.
 */
export function validateFreshTaskIds(plan: CommandCommitPlan): void {
  if (plan.freshTaskIds.length === 0) {
    return;
  }
  const comments = new Set<string>();
  const changed = new Set<string>();
  for (const transition of plan.transitions) {
    for (const effect of transition.effects) {
      if (effect.kind === "comment") {
        comments.add(effect.taskId);
      } else {
        changed.add(effect.after.id);
      }
    }
  }
  for (const id of plan.freshTaskIds) {
    if (!comments.has(id) || changed.has(id)) {
      throw new RelayError("VALIDATION_ERROR", commandStorageMessages.invalidFreshTask, 2, { id });
    }
  }
}

/**
 * Отличает объект технического комментария от null и массива до проверки строковых полей.
 */
function commentObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Проверяет техническую форму сохранённого комментария, не применяя предметные ограничения текста.
 * Ошибка строки хранения возвращается как CORRUPT_DATA, а не как неверный пользовательский ввод.
 */
function storedComment(value: unknown, taskId: string): TaskComment {
  if (!commentObject(value)) {
    throw new RelayError("CORRUPT_DATA", commandStorageMessages.invalidJournal, 1, { taskId });
  }
  try {
    return decodeTaskComment(value);
  } catch (cause) {
    const error = new RelayError("CORRUPT_DATA", commandStorageMessages.invalidJournal, 1, {
      taskId,
    });
    error.cause = cause;
    throw error;
  }
}

/**
 * Проверяет проекцию журнала уже загруженной свежей карточки без повторного SQL.
 */
function taskJournal(record: EntityRecord): TaskComment[] {
  const comments = record.data.comments;
  if (!Array.isArray(comments)) {
    throw new RelayError("CORRUPT_DATA", commandStorageMessages.invalidJournal, 1, {
      taskId: record.id,
    });
  }
  return comments.map((entry) => storedComment(entry, record.id));
}

/**
 * Читает полные журналы только объявленных задач и поколение того же commit-снимка.
 * Только freshTaskIds загружаются с актуальным содержанием; их журналы используются повторно из карточек.
 * Остальные commentTaskIds читаются узкой SQL-проекцией. Чтения не создают content dependencies.
 */
export function readCommandFacts(
  connection: Database,
  taskIds: readonly string[],
  freshTaskIds: readonly string[],
): CommandCommitFacts {
  const comments = new Map<string, TaskComment[]>(taskIds.map((id) => [id, []]));
  const freshIds = [...new Set(freshTaskIds)];
  const taskRecords = new Map(
    getEntities(connection, freshIds, "task").map((record) => [record.id, record]),
  );
  for (const id of freshIds) {
    const record = taskRecords.get(id);
    if (record === undefined) {
      throw new RelayError("STORAGE_ERROR", commandStorageMessages.missingFreshTask, 1, { id });
    }
    const journal = taskJournal(record);
    if (comments.has(id)) {
      comments.set(id, journal);
    }
  }
  const remaining = [...comments.keys()].filter((id) => !taskRecords.has(id));
  if (remaining.length > 0) {
    const rows = connection
      .query<CommandCommentRow, [string]>(
        `
      SELECT c.task_id AS taskId,${TASK_COMMENT_JSON} AS json
      FROM ${TASK_COMMENT_SOURCE}
      WHERE c.task_id IN (SELECT value FROM json_each(?)) ORDER BY c.task_id,c.sequence
    `,
      )
      .all(JSON.stringify(remaining));
    for (const { taskId, json } of rows) {
      const value: unknown = JSON.parse(json);
      comments.get(taskId)?.push(storedComment(value, taskId));
    }
  }
  return { comments, taskRecords, generation: readCommandGeneration(connection) };
}
