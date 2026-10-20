import { statSync } from "node:fs";
import { RelayError, type EntityKind, type EntityRecord } from "@relay/contracts";
import type { ProjectDatabase } from "@relay/storage";
import { EntityService } from "./entities";
import { TASK_COLUMNS, TasksService } from "./tasks";

const kinds: readonly EntityKind[] = [
  "project",
  "product",
  "feature",
  "scenario",
  "application",
  "implementation",
  "board",
  "task",
  "document",
  "work-plan",
  "release",
  "work-session",
  "work-checkpoint",
];

const subjectFields: Partial<Record<EntityKind, readonly string[]>> = {
  project: ["slug"],
  application: ["slug", "prefix"],
  board: ["slug", "prefix"],
  document: ["body"],
  release: ["version"],
  "work-plan": ["goal", "rationale", "boundaries", "expectedResult", "result"],
  "work-session": ["result"],
  "work-checkpoint": ["body", "done", "remaining", "nextStep", "checks"],
};
const nestedText: Partial<Record<EntityKind, Record<string, readonly string[]>>> = {
  task: { acceptanceCriteria: ["title", "summary", "description"] },
  document: { relations: ["description"] },
  "work-plan": { stages: ["title", "summary", "outcome", "completionConditions"] },
  "work-session": { runs: ["reason", "endReason"] },
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function subjectMatches(entity: EntityRecord, query: string): boolean {
  const includes = (value: unknown): boolean =>
    typeof value === "string" && value.toLowerCase().includes(query);
  if ([entity.id, entity.key].some(includes)) return true;
  if (
    ["name", "title", "summary", "description", ...(subjectFields[entity.kind] ?? [])].some(
      (field) => includes(entity.data[field]),
    )
  )
    return true;
  // Явный состав текстов не превращает автора, дату и журнал комментариев в содержание карточки.
  return Object.entries(nestedText[entity.kind] ?? {}).some(([collection, fields]) => {
    const values = entity.data[collection];
    return (
      Array.isArray(values) &&
      values.some((value) => object(value) && fields.some((field) => includes(value[field])))
    );
  });
}

export interface ProjectOverview {
  items: EntityRecord[];
  project: EntityRecord;
  generation: number;
  counts: Record<EntityKind, number>;
  tasks: { total: number; columns: Record<string, number>; blocked: number };
}

export interface ProjectCheck {
  projectId: string;
  generation: number;
  valid: boolean;
  records: number;
  issues: string[];
}

const scalarReferences: Record<string, readonly EntityKind[]> = {
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
const arrayReferences: Record<string, readonly EntityKind[]> = {
  dependencies: ["task"],
  related: ["task"],
  taskIds: ["task"],
  planIds: ["work-plan"],
  implementationIds: ["implementation"],
  acceptedSessionIds: ["work-session"],
  targets: kinds,
  references: kinds,
  scope: ["project", "product", "application", "feature", "scenario", "implementation"],
};
const requiredReferences: Partial<Record<EntityKind, readonly string[]>> = {
  scenario: ["featureId"],
  application: ["boardId"],
  implementation: ["applicationId", "targetId"],
  task: ["boardId"],
  "work-checkpoint": ["sessionId"],
};
const requiredCollections: Partial<Record<EntityKind, readonly string[]>> = {
  application: ["implementationIds"],
  task: ["dependencies", "related", "targets", "acceptanceCriteria"],
  "work-plan": ["stages"],
  release: ["planIds"],
  "work-session": ["runs"],
  "work-checkpoint": ["references", "acceptedSessionIds"],
};

function inspectRecords(items: EntityRecord[], projectId: string): string[] {
  const issues: string[] = [];
  const byId = new Map(items.map((item) => [item.id, item]));
  const keys = new Set<string>();
  const projects = items.filter((item) => item.kind === "project");
  if (projects.length !== 1 || projects[0]?.id !== projectId)
    issues.push("Не найдена единственная запись проекта с ожидаемым ID");
  if (items.filter((item) => item.kind === "product").length !== 1)
    issues.push("Ожидается единственный паспорт продукта");
  if (items.filter((item) => item.kind === "board" && item.data.slug === "product").length !== 1)
    issues.push("Ожидается единственная продуктовая доска");
  if (byId.size !== items.length) issues.push("Обнаружены повторные ID сущностей");

  function reference(value: unknown, path: string, expected: readonly EntityKind[] = kinds): void {
    const id = typeof value === "string" ? value : object(value) ? value.id : undefined;
    if (typeof id !== "string" || !id) {
      issues.push(`${path}: некорректная ссылка`);
      return;
    }
    const target = byId.get(id);
    if (!target) issues.push(`${path}: отсутствует цель ${id}`);
    else if (
      !expected.includes(target.kind) ||
      (object(value) && value.kind !== undefined && value.kind !== target.kind)
    ) {
      issues.push(`${path}: тип ссылки не совпадает с типом цели ${id}`);
    }
  }
  function walk(value: unknown, path: string): void {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      const location = `${path}.${key}`;
      if (Object.hasOwn(scalarReferences, key) && child !== null)
        reference(child, location, scalarReferences[key]);
      if (Object.hasOwn(arrayReferences, key)) {
        if (Array.isArray(child))
          child.forEach((ref, index) =>
            reference(ref, `${location}[${index}]`, arrayReferences[key]),
          );
        else issues.push(`${location}: ожидается массив ссылок`);
      }
      if (key === "target") reference(child, location);
      if (typeof child === "object") walk(child, location);
    }
  }
  for (const item of items) {
    if (!kinds.includes(item.kind)) issues.push(`${item.key}: неизвестный тип сущности`);
    if (keys.has(item.key)) issues.push(`Повторный ключ ${item.key}`);
    keys.add(item.key);
    if (!item.key || /[\s:\p{Cc}]/u.test(item.key)) issues.push(`${item.id}: недопустимый ключ`);
    if (!Number.isSafeInteger(item.revision) || item.revision < 1)
      issues.push(`${item.key}: недопустимая ревизия`);
    if (!item.createdBy?.trim() || !item.updatedBy?.trim())
      issues.push(`${item.key}: отсутствует автор`);
    if (
      !Number.isFinite(Date.parse(item.createdAt)) ||
      !Number.isFinite(Date.parse(item.updatedAt))
    )
      issues.push(`${item.key}: недопустимая дата`);
    for (const field of requiredReferences[item.kind] ?? []) {
      if (typeof item.data[field] !== "string" || !item.data[field])
        issues.push(`${item.key}.${field}: отсутствует обязательная ссылка`);
    }
    for (const field of requiredCollections[item.kind] ?? []) {
      if (!Array.isArray(item.data[field])) issues.push(`${item.key}.${field}: ожидается массив`);
    }
    walk(item.data, item.key);
    if (item.kind === "application") {
      const board = byId.get(String(item.data.boardId));
      if (board && board.data.applicationId !== item.id)
        issues.push(`${item.key}: доска не ссылается на своё приложение`);
    }
    if (item.kind === "board" && typeof item.data.applicationId === "string") {
      const application = byId.get(item.data.applicationId);
      if (application && application.data.boardId !== item.id)
        issues.push(`${item.key}: приложение не ссылается на свою доску`);
    }
    if (item.kind === "work-session" && item.data.currentRunId !== null) {
      const runs = item.data.runs;
      if (
        !Array.isArray(runs) ||
        !runs.some((run) => object(run) && run.id === item.data.currentRunId)
      )
        issues.push(`${item.key}: текущее участие отсутствует в сессии`);
    }
    if (item.kind === "work-checkpoint") {
      const runs = byId.get(String(item.data.sessionId))?.data.runs;
      if (!Array.isArray(runs) || !runs.some((run) => object(run) && run.id === item.data.runId))
        issues.push(`${item.key}: участие контрольной точки отсутствует в её сессии`);
    }
  }
  return issues;
}

/** Согласованные чтения проекта; открытие БД само по себе не доказывает целостность данных. */
export class QueryService {
  static readonly kinds = kinds;
  private readonly entities: EntityService;
  private readonly tasks: TasksService;

  constructor(private readonly db: ProjectDatabase) {
    this.entities = new EntityService(db);
    this.tasks = new TasksService(db);
  }

  get(ref: string): EntityRecord {
    return this.db.snapshot(() => this.entities.get(ref));
  }

  search(input: Record<string, unknown>): EntityRecord[] {
    if (!object(input) || Object.keys(input).some((key) => !["q", "kind"].includes(key))) {
      throw new RelayError("INVALID_ARGUMENT", "Поиск принимает только поля q и kind", 2);
    }
    if (typeof input.q !== "string" || !input.q.trim())
      throw new RelayError("INVALID_ARGUMENT", "Укажите непустой поисковый запрос", 2);
    if (input.kind !== undefined && !kinds.includes(input.kind as EntityKind))
      throw new RelayError("INVALID_ARGUMENT", "Неизвестный тип сущности", 2);
    const query = input.q;
    const selected = input.kind as EntityKind | undefined;
    return this.db.snapshot(() => {
      let exactId: string | undefined;
      try {
        exactId = this.entities.get(query, selected).id;
      } catch (error) {
        // Произвольный текст запроса не обязан быть адресом, но отказ хранилища скрывать нельзя.
        if (
          !(error instanceof RelayError) ||
          !["NOT_FOUND", "INVALID_ARGUMENT", "VALIDATION_ERROR"].includes(error.code)
        )
          throw error;
      }
      const lowered = query.toLowerCase();
      return this.entities
        .list(selected)
        .filter((item) => item.id === exactId || subjectMatches(item, lowered));
    });
  }

  overview(): ProjectOverview {
    return this.db.snapshot(() => {
      const items = this.entities
        .list()
        .sort((a, b) => a.key.localeCompare(b.key) || a.id.localeCompare(b.id));
      const tasks = items.filter((item) => item.kind === "task");
      return {
        items,
        project: this.entities.get(this.db.projectId, "project"),
        generation: this.db.getGeneration(),
        counts: Object.fromEntries(
          kinds.map((kind) => [kind, items.filter((item) => item.kind === kind).length]),
        ) as Record<EntityKind, number>,
        tasks: {
          total: tasks.length,
          columns: Object.fromEntries(
            TASK_COLUMNS.map((column) => [
              column,
              tasks.filter((task) => task.data.column === column).length,
            ]),
          ),
          blocked: this.tasks.list({ readiness: "blocked" }).length,
        },
      };
    });
  }

  status(): {
    projectId: string;
    databasePath: string;
    bytes: number;
    generation: number;
    records: number;
  } {
    return this.db.snapshot(() => ({
      projectId: this.db.projectId,
      databasePath: this.db.path,
      bytes: statSync(this.db.path).size,
      generation: this.db.getGeneration(),
      records: this.entities.list().length,
    }));
  }

  check(): ProjectCheck {
    return this.db.snapshot(() => {
      const items = this.entities.list();
      const issues = inspectRecords(items, this.db.projectId);
      try {
        this.tasks.list({ readiness: "blocked" });
      } catch (error) {
        if (
          !(error instanceof RelayError) ||
          !["CORRUPT_DATA", "BROKEN_REFERENCE", "TASK_CYCLE"].includes(error.code)
        )
          throw error;
        issues.push(`${error.code}: ${error.message}`);
      }
      const check = { valid: issues.length === 0, records: items.length, issues };
      if (!check.valid)
        throw new RelayError(
          "INTEGRITY_ERROR",
          `Обнаружены нарушения: ${issues.join("; ")}`,
          1,
          check,
        );
      return { projectId: this.db.projectId, generation: this.db.getGeneration(), ...check };
    });
  }
}
