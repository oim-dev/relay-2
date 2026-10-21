import {
  ENTITY_KINDS,
  PLAN_SCOPE_KINDS,
  type EntityKind,
  type EntityRecord,
} from "@relay/contracts";
import { queryMessages } from "./queries.messages";
import type { EntityIntegrityIndex } from "./queries-doctor.types";

const scalarReferences: Readonly<Record<string, readonly EntityKind[]>> = {
  projectId: ["project"],
  boardId: ["board"],
  applicationId: ["application"],
  featureId: ["feature"],
  scenarioId: ["scenario"],
  targetId: ["feature", "scenario"],
  parentId: ["task"],
  sessionId: ["work-session"],
  parentSessionId: ["work-session"],
  intentId: ["work-checkpoint"],
  sourceIntentId: ["work-checkpoint"],
  originCheckpointId: ["work-checkpoint"],
};
const arrayReferences: Readonly<Record<string, readonly EntityKind[]>> = {
  dependencies: ["task"],
  related: ["task"],
  taskIds: ["task"],
  planIds: ["work-plan"],
  implementationIds: ["implementation"],
  acceptedSessionIds: ["work-session"],
  targets: ENTITY_KINDS,
  references: ENTITY_KINDS,
  scope: PLAN_SCOPE_KINDS,
};
const requiredReferences: Readonly<Partial<Record<EntityKind, readonly string[]>>> = {
  scenario: ["featureId"],
  application: ["boardId"],
  implementation: ["applicationId", "targetId"],
  task: ["boardId"],
  "work-checkpoint": ["sessionId"],
};
const requiredCollections: Readonly<Partial<Record<EntityKind, readonly string[]>>> = {
  application: ["implementationIds"],
  task: ["dependencies", "related", "targets", "acceptanceCriteria"],
  "work-plan": ["stages"],
  release: ["planIds"],
  "work-session": ["runs"],
  "work-checkpoint": ["references", "acceptedSessionIds"],
};

/**
 * Отличает сохранённый вложенный объект от массива и null на диагностической границе.
 */
function isStoredObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Индексирует записи и участия один раз для диагностики всего снимка без запросов к БД.
 * Сырые ID участий сохраняются для проверки даже при повреждённом содержании сессии.
 */
export function indexIntegrityRecords(items: readonly EntityRecord[]): EntityIntegrityIndex {
  const byId = new Map(items.map((item) => [item.id, item]));
  const counts = new Map<EntityKind, number>();
  const runIds = new Map<string, ReadonlySet<unknown>>();
  let productBoards = 0;
  for (const item of items) {
    counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
    if (item.kind === "board" && item.data.slug === "product") {
      productBoards++;
    }
    if (Array.isArray(item.data.runs)) {
      runIds.set(item.id, new Set(item.data.runs.filter(isStoredObject).map((run) => run.id)));
    }
  }
  return { byId, counts, productBoards, runIds };
}

/**
 * Проверяет одну сырую ссылку по общему индексу и возвращает диагностику либо отсутствие ошибки.
 * Ожидаемый вид и явно сохранённый kind независимо ограничивают вид существующей цели.
 */
function inspectReference(
  value: unknown,
  path: string,
  index: EntityIntegrityIndex,
  expected: readonly EntityKind[] = ENTITY_KINDS,
): string | undefined {
  let id: unknown = value;
  if (isStoredObject(value)) {
    id = value.id;
  }
  if (typeof id !== "string" || !id) {
    return queryMessages.invalidReference(path);
  }
  const target = index.byId.get(id);
  if (!target) {
    return queryMessages.missingReference(path, id);
  }
  if (
    !expected.includes(target.kind) ||
    (isStoredObject(value) && value.kind !== undefined && value.kind !== target.kind)
  ) {
    return queryMessages.referenceKind(path, id);
  }
  return undefined;
}

/**
 * Проверяет форму коллекции и каждую её ссылку по общему индексу без изменения входа.
 */
function inspectReferenceCollection(
  value: unknown,
  path: string,
  index: EntityIntegrityIndex,
  expected: readonly EntityKind[] | undefined,
): string[] {
  if (!Array.isArray(value)) {
    return [queryMessages.referenceArray(path)];
  }
  const issues: string[] = [];
  for (const [position, ref] of value.entries()) {
    const issue = inspectReference(ref, `${path}[${position}]`, index, expected);
    if (issue !== undefined) {
      issues.push(issue);
    }
  }
  return issues;
}

/**
 * Находит ссылки в сыром JSON-дереве и дописывает нарушения в переданный список.
 * Само дерево не меняется; индекс принадлежит общему снимку, а не отдельной карточке.
 */
function inspectReferenceTree(
  value: unknown,
  path: string,
  index: EntityIntegrityIndex,
  issues: string[],
): void {
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const location = `${path}.${key}`;
    if (Object.hasOwn(scalarReferences, key) && child !== null) {
      const issue = inspectReference(child, location, index, scalarReferences[key]);
      if (issue !== undefined) {
        issues.push(issue);
      }
    }
    if (Object.hasOwn(arrayReferences, key)) {
      for (const issue of inspectReferenceCollection(
        child,
        location,
        index,
        arrayReferences[key],
      )) {
        issues.push(issue);
      }
    }
    if (key === "target") {
      const issue = inspectReference(child, location, index);
      if (issue !== undefined) {
        issues.push(issue);
      }
    }
    if (typeof child === "object") {
      inspectReferenceTree(child, location, index, issues);
    }
  }
}

/**
 * Дописывает нарушения обязательных полей, сохраняя различие отсутствия и неверной формы.
 */
function inspectRequiredFields(item: Readonly<EntityRecord>, issues: string[]): void {
  for (const field of requiredReferences[item.kind] ?? []) {
    if (typeof item.data[field] !== "string" || !item.data[field]) {
      issues.push(queryMessages.requiredReference(`${item.key}.${field}`));
    }
  }
  for (const field of requiredCollections[item.kind] ?? []) {
    if (!Array.isArray(item.data[field])) {
      issues.push(queryMessages.requiredArray(`${item.key}.${field}`));
    }
  }
}

/**
 * Проверяет встречные связи доски/приложения и принадлежность участий истории.
 * Отсутствующие цели отдельно диагностируются обходом ссылок, нарушения добавляются в issues.
 */
function inspectBacklinks(
  item: Readonly<EntityRecord>,
  index: EntityIntegrityIndex,
  issues: string[],
): void {
  if (item.kind === "application") {
    const board = index.byId.get(String(item.data.boardId));
    if (board && board.data.applicationId !== item.id) {
      issues.push(queryMessages.missingBoardBacklink(item.key));
    }
  }
  if (item.kind === "board" && typeof item.data.applicationId === "string") {
    const application = index.byId.get(item.data.applicationId);
    if (application && application.data.boardId !== item.id) {
      issues.push(queryMessages.missingApplicationBacklink(item.key));
    }
  }
  if (item.kind === "work-session" && item.data.currentRunId !== null) {
    if (!index.runIds.get(item.id)?.has(item.data.currentRunId)) {
      issues.push(queryMessages.missingCurrentRun(item.key));
    }
  }
  if (item.kind === "work-checkpoint") {
    if (!index.runIds.get(String(item.data.sessionId))?.has(item.data.runId)) {
      issues.push(queryMessages.missingCheckpointRun(item.key));
    }
  }
}

/**
 * Диагностирует обязательные поля и структурированные связи одной сырой карточки.
 * Использует общие индексы операции; не читает БД и не изменяет запись.
 */
export function inspectEntityReferences(
  item: Readonly<EntityRecord>,
  index: EntityIntegrityIndex,
): string[] {
  const issues: string[] = [];
  inspectRequiredFields(item, issues);
  inspectReferenceTree(item.data, item.key, index, issues);
  inspectBacklinks(item, index, issues);
  return issues;
}
