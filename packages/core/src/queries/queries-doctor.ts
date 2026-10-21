import { RelayError, isEntityKind, type EntityRecord, type TaskRecord } from "@relay/contracts";
import type { ProjectDatabase } from "@relay/storage";
import { EntityReader } from "../projections/entity-reader";
import { indexIntegrityRecords, inspectEntityReferences } from "./queries-doctor-references";
import { queryMessages } from "./queries.messages";
import { taskGraphNode } from "../tasks/task-data";
import { TaskGraph } from "../tasks/task-graph";
import type { EntityDecodingInspection, EntityIntegrityIndex } from "./queries-doctor.types";
import type { ProjectCheck } from "./queries.types";

/**
 * Проверяет наличие единственных базовых записей и уникальность ID по индексу снимка.
 */
function inspectProjectRecords(
  index: EntityIntegrityIndex,
  projectId: string,
  total: number,
): string[] {
  const issues: string[] = [];
  if (index.counts.get("project") !== 1 || index.byId.get(projectId)?.kind !== "project") {
    issues.push(queryMessages.projectRecord);
  }
  if (index.counts.get("product") !== 1) {
    issues.push(queryMessages.productRecord);
  }
  if (index.productBoards !== 1) {
    issues.push(queryMessages.productBoard);
  }
  if (index.byId.size !== total) {
    issues.push(queryMessages.duplicateIds);
  }
  return issues;
}

/**
 * Проверяет общие метаданные сырой карточки, добавляя её ключ в набор уже встреченных.
 * Набор ключей локален снимку; содержимое карточки не изменяется.
 */
function inspectRecordMetadata(item: Readonly<EntityRecord>, keys: Set<string>): string[] {
  const issues: string[] = [];
  if (!isEntityKind(item.kind)) {
    issues.push(queryMessages.unknownEntityKind(item.key));
  }
  if (keys.has(item.key)) {
    issues.push(queryMessages.duplicateKey(item.key));
  }
  keys.add(item.key);
  if (!item.key || /[\s:\p{Cc}]/u.test(item.key)) {
    issues.push(queryMessages.invalidKey(item.id));
  }
  if (!Number.isSafeInteger(item.revision) || item.revision < 1) {
    issues.push(queryMessages.invalidRevision(item.key));
  }
  if (!item.createdBy?.trim() || !item.updatedBy?.trim()) {
    issues.push(queryMessages.missingAuthor(item.key));
  }
  if (
    !Number.isFinite(Date.parse(item.createdAt)) ||
    !Number.isFinite(Date.parse(item.updatedAt))
  ) {
    issues.push(queryMessages.invalidDate(item.key));
  }
  return issues;
}

/**
 * Проверяет структуру всего снимка с одним индексом сущностей и участий истории.
 */
function inspectRecords(items: readonly EntityRecord[], projectId: string): string[] {
  const index = indexIntegrityRecords(items);
  const issues = inspectProjectRecords(index, projectId, items.length);
  const keys = new Set<string>();
  for (const item of items) {
    const itemIssues = [
      ...inspectRecordMetadata(item, keys),
      ...inspectEntityReferences(item, index),
    ];
    for (const issue of itemIssues) {
      issues.push(issue);
    }
  }
  return issues;
}

/**
 * Декодирует все карточки единственным reader и сохраняет проверенные задачи для общего графа.
 * CORRUPT_DATA добавляется в диагностику; неожиданные ошибки и отказы хранилища пробрасываются.
 * Первая повреждённая задача сохраняется, чтобы неполный набор не прошёл проверку графа.
 */
function inspectDecodedRecords(
  db: ProjectDatabase,
  items: readonly EntityRecord[],
): EntityDecodingInspection {
  const reader = new EntityReader(db);
  const tasks: TaskRecord[] = [];
  const issues: string[] = [];
  let taskError: RelayError | undefined;
  for (const item of items) {
    try {
      const decoded = reader.decode(item);
      if (decoded.kind === "task") {
        tasks.push(decoded);
      }
    } catch (error) {
      if (!(error instanceof RelayError) || error.code !== "CORRUPT_DATA") {
        throw error;
      }
      issues.push(queryMessages.invalidRecord(item.key, error.message));
      if (item.kind === "task") {
        taskError ??= error;
      }
    }
  }
  return { tasks, taskError, issues };
}

/**
 * Проверяет один полный граф уже декодированных задач без повторного чтения БД.
 * Неверная задача, отсутствующее обязательство и цикл остаются предметными диагностиками.
 */
function inspectTaskGraph(inspection: EntityDecodingInspection): string[] {
  if (inspection.taskError !== undefined) {
    return [
      queryMessages.invalidTaskGraph(inspection.taskError.code, inspection.taskError.message),
    ];
  }
  try {
    new TaskGraph(inspection.tasks.map(taskGraphNode));
    return [];
  } catch (error) {
    if (
      !(error instanceof RelayError) ||
      !["CORRUPT_DATA", "BROKEN_REFERENCE", "TASK_CYCLE"].includes(error.code)
    ) {
      throw error;
    }
    return [queryMessages.invalidTaskGraph(error.code, error.message)];
  }
}

/**
 * Диагностирует полный проект внутри удерживаемого вызывающим кодом снимка без записи.
 * Полный список загружается один раз; ссылки, разделы и граф задач используют общие индексы.
 * При нарушениях выбрасывается INTEGRITY_ERROR со всеми найденными issues и числом записей.
 */
export function checkProjectIntegrity(db: ProjectDatabase): ProjectCheck {
  const items = db.list();
  const structuralIssues = inspectRecords(items, db.projectId);
  const inspection = inspectDecodedRecords(db, items);
  const issues = [...structuralIssues, ...inspection.issues, ...inspectTaskGraph(inspection)];
  const check = { valid: issues.length === 0, records: items.length, issues };
  if (!check.valid) {
    throw new RelayError("INTEGRITY_ERROR", queryMessages.integrityError(issues), 1, check);
  }
  return { projectId: db.projectId, generation: db.getGeneration(), ...check };
}
