import { randomUUID } from "node:crypto";
import { RelayError, type EntityRecord, type WriteOptions } from "@relay/contracts";
import type { ProjectDatabase } from "@relay/storage";
import { EntityService } from "./entities";

export const TASK_COLUMNS = [
  "inbox",
  "ready",
  "in-progress",
  "review",
  "done",
  "cancelled",
] as const;

export type TaskColumn = (typeof TASK_COLUMNS)[number];

export interface TaskCriterion {
  id: string;
  title: string;
  summary: string;
  description: string;
  completed: boolean;
  completedAt: string | null;
  completedBy: string | null;
}

export interface TaskComment extends Record<string, unknown> {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  createdBy: string;
}

export interface TaskProgress {
  completed: boolean;
  canComplete: boolean;
  /** Постоянные ID невыполненных прямых детей и зависимостей, без повторов. */
  blockers: string[];
}

interface TaskData extends Record<string, unknown> {
  boardId: string;
  title: string;
  description: string;
  column: TaskColumn;
  parentId: string | null;
  dependencies: string[];
  related: string[];
  targets: string[];
  acceptanceCriteria: TaskCriterion[];
}

function invalid(message: string): never {
  throw new RelayError("INVALID_ARGUMENT", message, 2);
}

function object(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${label}: ожидается объект`);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    invalid(`${label}: ожидается обычный объект полей`);
  }
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result)) {
    if (!fields.includes(key)) invalid(`${label}: неизвестное поле ${key}`);
    if (result[key] === undefined) invalid(`${label}: поле ${key} не может быть undefined`);
    if (result[key] === null && key !== "parent")
      invalid(`${label}: поле ${key} не может быть null`);
  }
  return result;
}

function text(
  value: unknown,
  name: string,
  max: number,
  singleLine = false,
  required = false,
): string {
  if (typeof value !== "string" || value.length > max || value.includes("\0")) {
    invalid(`${name}: ожидается строка длиной не более ${max} символов без NUL`);
  }
  if (singleLine && /[\r\n\u2028\u2029]/u.test(value)) invalid(`${name}: нужна одна строка`);
  if (required && !value.trim()) invalid(`${name}: пустое значение недопустимо`);
  return value;
}

function reference(value: unknown, name: string): string {
  const result = text(value, name, 256, true, true);
  if (result !== result.trim() || /\p{Cc}/u.test(result))
    invalid(`${name}: пробелы по краям и управляющие символы недопустимы`);
  return result;
}

function column(value: unknown): TaskColumn {
  if (typeof value !== "string" || !(TASK_COLUMNS as readonly string[]).includes(value)) {
    invalid(`Неизвестная колонка; допустимы ${TASK_COLUMNS.join(", ")}`);
  }
  return value as TaskColumn;
}

function choice(value: unknown, variants: readonly string[], name: string): string {
  if (typeof value !== "string" || !variants.includes(value)) {
    invalid(`${name}: допустимы ${variants.join(", ")}`);
  }
  return value;
}

function array(value: unknown, name: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) {
    invalid(`${name}: ожидается массив длиной не более ${max}`);
  }
  return value;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function criterionContent(
  input: unknown,
): Pick<TaskCriterion, "title" | "summary" | "description"> {
  const value = object(input, ["title", "summary", "description"], "Критерий");
  return {
    title: text(value.title, "Заголовок критерия", 1024, true, true),
    summary: text(value.summary ?? "", "Краткое описание критерия", 4096),
    description: text(value.description ?? "", "Описание критерия", 256 * 1024),
  };
}

function newCriterion(input: unknown): TaskCriterion {
  return {
    id: randomUUID(),
    ...criterionContent(input),
    completed: false,
    completedAt: null,
    completedBy: null,
  };
}

function taskData(task: EntityRecord): TaskData {
  const data = task.data;
  const fail = (): never => {
    throw new RelayError("CORRUPT_DATA", `Повреждена задача ${task.key}`, 1, { id: task.id });
  };
  if (
    typeof data.boardId !== "string" ||
    typeof data.title !== "string" ||
    typeof data.description !== "string" ||
    !(TASK_COLUMNS as readonly unknown[]).includes(data.column) ||
    (data.parentId !== null && typeof data.parentId !== "string")
  ) {
    fail();
  }
  for (const key of ["dependencies", "related", "targets"] as const) {
    const values = data[key];
    if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) fail();
  }
  if (!Array.isArray(data.acceptanceCriteria)) fail();
  const criteria = data.acceptanceCriteria as unknown[];
  const ids = new Set<string>();
  for (const value of criteria) {
    if (!value || typeof value !== "object") fail();
    const item = value as Record<string, unknown>;
    if (
      typeof item.id !== "string" ||
      ids.has(item.id) ||
      typeof item.title !== "string" ||
      typeof item.summary !== "string" ||
      typeof item.description !== "string" ||
      typeof item.completed !== "boolean" ||
      (item.completed
        ? typeof item.completedAt !== "string" || typeof item.completedBy !== "string"
        : item.completedAt !== null || item.completedBy !== null)
    ) {
      fail();
    }
    ids.add(item.id as string);
  }
  return data as TaskData;
}

/** Один снимок графа: родители ожидают детей, задачи — свои обязательные зависимости. */
class TaskGraph {
  readonly records = new Map<string, EntityRecord>();
  readonly data = new Map<string, TaskData>();
  readonly results = new Map<string, TaskProgress>();

  constructor(records: EntityRecord[]) {
    for (const record of records) {
      this.records.set(record.id, record);
      this.data.set(record.id, taskData(record));
    }
    const obligations = new Map<string, Set<string>>();
    const dependants = new Map<string, Set<string>>();
    for (const id of this.records.keys()) {
      obligations.set(id, new Set());
      dependants.set(id, new Set());
    }
    const link = (source: string, target: string) => {
      if (source === target) {
        throw new RelayError("TASK_CYCLE", "Самоссылка задачи запрещена", 2, { id: source });
      }
      if (!this.records.has(source) || !this.records.has(target)) {
        throw new RelayError(
          "BROKEN_REFERENCE",
          "В графе задач отсутствует обязательная задача",
          1,
          {
            source,
            target,
          },
        );
      }
      obligations.get(source)!.add(target);
      dependants.get(target)!.add(source);
    };
    for (const [id, data] of this.data) {
      for (const dependency of data.dependencies) link(id, dependency);
      if (data.parentId) link(data.parentId, id);
    }

    // Обход от листьев не зависит от глубины декомпозиции и не переполняет стек.
    const remaining = new Map([...obligations].map(([id, items]) => [id, items.size]));
    const queue = [...remaining].filter(([, count]) => count === 0).map(([id]) => id);
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index]!;
      const data = this.data.get(id)!;
      const blockers = [...obligations.get(id)!].filter(
        (target) => !this.results.get(target)!.completed,
      );
      const canComplete =
        blockers.length === 0 && data.acceptanceCriteria.every((item) => item.completed);
      this.results.set(id, {
        completed: data.column === "done" && canComplete,
        canComplete,
        blockers,
      });
      for (const dependant of dependants.get(id)!) {
        const count = remaining.get(dependant)! - 1;
        remaining.set(dependant, count);
        if (count === 0) queue.push(dependant);
      }
    }
    if (queue.length !== this.records.size) {
      throw new RelayError(
        "TASK_CYCLE",
        "Обнаружен цикл родительства и обязательных зависимостей",
        2,
      );
    }
  }

  progress(id: string): TaskProgress {
    const result = this.results.get(id);
    if (!result) throw new RelayError("NOT_FOUND", "Задача не найдена", 3, { id });
    return { ...result, blockers: [...result.blockers] };
  }
}

/** Локальные сценарии задач; проверки и запись используют одну транзакцию проекта. */
export class TasksService {
  readonly db: ProjectDatabase;
  private readonly entities: EntityService;

  constructor(db: ProjectDatabase) {
    this.db = db;
    this.entities = new EntityService(db);
  }

  get(ref: string): EntityRecord {
    return this.entities.get(reference(ref, "Задача"), "task");
  }

  list(filters: Record<string, unknown> = {}): EntityRecord[] {
    object(
      filters,
      [
        "board",
        "column",
        "parent",
        "parentId",
        "completion",
        "searchIn",
        "q",
        "readiness",
        "target",
        "productTarget",
      ],
      "Фильтры задач",
    );
    return this.db.snapshot(() => {
      if (filters.parent !== undefined && filters.parentId !== undefined)
        invalid("Передайте только parent или parentId");
      if (filters.target !== undefined && filters.productTarget !== undefined)
        invalid("Передайте только target или productTarget");
      const boardId =
        filters.board === undefined ? undefined : this.board(reference(filters.board, "Доска")).id;
      const selectedColumn = filters.column === undefined ? undefined : column(filters.column);
      const parent = filters.parent !== undefined ? filters.parent : filters.parentId;
      const parentId =
        parent === undefined
          ? undefined
          : parent === null
            ? null
            : this.get(reference(parent, "Родитель")).id;
      const completion =
        filters.completion === undefined
          ? undefined
          : choice(filters.completion, ["finished", "unfinished"], "Завершённость");
      const searchIn =
        filters.searchIn === undefined
          ? "all"
          : choice(filters.searchIn, ["title", "all"], "Область поиска");
      const query =
        filters.q === undefined ? "" : text(filters.q, "Поиск", 1024).toLocaleLowerCase();
      const readiness =
        filters.readiness === undefined
          ? undefined
          : choice(filters.readiness, ["ready", "blocked"], "Готовность");
      const target = filters.target ?? filters.productTarget;
      const targetIds =
        target === undefined
          ? undefined
          : this.targetScope(reference(target, "Цель"), filters.productTarget !== undefined);
      const records = this.db.list("task");
      const graph = readiness === undefined ? undefined : new TaskGraph(records);
      return records.filter((record) => {
        const data = taskData(record);
        if (boardId !== undefined && data.boardId !== boardId) return false;
        if (selectedColumn !== undefined && data.column !== selectedColumn) return false;
        if (parentId !== undefined && data.parentId !== parentId) return false;
        const finished = data.column === "done" || data.column === "cancelled";
        if (completion !== undefined && finished !== (completion === "finished")) return false;
        if (targetIds && !data.targets.some((id) => targetIds.has(id))) return false;
        if (
          query &&
          ![
            record.id,
            record.key,
            data.title,
            ...(searchIn === "all" ? [data.description] : []),
          ].some((value) => value.toLocaleLowerCase().includes(query))
        )
          return false;
        if (readiness) {
          const blocked = graph!.progress(record.id).blockers.length > 0;
          if (readiness === "blocked" ? !blocked : blocked || data.column !== "ready") return false;
        }
        return true;
      });
    });
  }

  create(input: Record<string, unknown>, actor: string): EntityRecord {
    object(
      input,
      [
        "board",
        "title",
        "description",
        "column",
        "parent",
        "dependencies",
        "related",
        "targets",
        "acceptanceCriteria",
      ],
      "Создание задачи",
    );
    reference(actor, "Автор");
    return this.db.transaction(() => {
      const board = this.board(reference(input.board ?? "BOARD-PRODUCT", "Доска"));
      const data: TaskData = {
        boardId: board.id,
        title: text(input.title ?? "", "Заголовок задачи", 1024, true),
        description: text(input.description ?? "", "Описание задачи", 256 * 1024),
        column: column(input.column ?? "inbox"),
        parentId:
          input.parent === undefined || input.parent === null
            ? null
            : this.get(reference(input.parent, "Родитель")).id,
        dependencies: this.taskReferences(input.dependencies ?? [], "Зависимости"),
        related: this.taskReferences(input.related ?? [], "Связанные задачи"),
        targets: this.targets(input.targets ?? [], board, []),
        acceptanceCriteria: array(input.acceptanceCriteria ?? [], "Критерии", 100).map(
          newCriterion,
        ),
      };
      const record = this.entities.create("task", this.prefix(board), data, actor);
      const graph = this.graph(record);
      this.ensureDone(record, graph);
      this.ensureParentAccepts(record, null, graph);
      return record;
    });
  }

  update(ref: string, input: Record<string, unknown>, options: WriteOptions): EntityRecord {
    object(input, ["title", "description", "targets"], "Обновление задачи");
    if (Object.keys(input).length === 0) invalid("Передайте хотя бы одно поле задачи");
    return this.db.transaction(() => {
      const record = this.writable(ref, options);
      const data = { ...taskData(record) };
      if (input.title !== undefined) data.title = text(input.title, "Заголовок задачи", 1024, true);
      if (input.description !== undefined)
        data.description = text(input.description, "Описание задачи", 256 * 1024);
      if (input.targets !== undefined)
        data.targets = this.targets(input.targets, this.board(data.boardId), data.targets);
      return this.save(record, data, options);
    });
  }

  move(ref: string, input: Record<string, unknown>, options: WriteOptions): EntityRecord {
    object(input, ["board", "column"], "Перенос задачи");
    if (Object.keys(input).length === 0) invalid("Передайте доску или колонку");
    return this.db.transaction(() => {
      const record = this.writable(ref, options);
      const previous = taskData(record);
      const board = this.board(
        input.board === undefined ? previous.boardId : reference(input.board, "Доска"),
      );
      const data: TaskData = {
        ...previous,
        boardId: board.id,
        column: input.column === undefined ? previous.column : column(input.column),
      };
      this.targets(data.targets, board, board.id === previous.boardId ? previous.targets : []);
      const candidate = { ...record, data };
      this.ensureDone(candidate, this.graph(candidate));
      if (board.id === previous.boardId) return this.save(record, data, options);
      // Storage резервирует прежний ключ как алиас при атомарном изменении записи.
      const moved: EntityRecord = {
        ...record,
        data,
        key: this.db.nextKey(this.prefix(board)),
        revision: record.revision + 1,
        updatedAt: new Date().toISOString(),
        updatedBy: options.actor,
      };
      this.db.update(moved, options.ifRevision);
      return moved;
    });
  }

  setParent(ref: string, parent: string | null, options: WriteOptions): EntityRecord {
    return this.db.transaction(() => {
      const record = this.writable(ref, options);
      const previous = taskData(record);
      const parentId = parent === null ? null : this.get(reference(parent, "Родитель")).id;
      const data = { ...previous, parentId };
      const candidate = { ...record, data };
      const graph = this.graph(candidate);
      this.ensureParentAccepts(candidate, previous.parentId, graph);
      return this.save(record, data, options);
    });
  }

  dependency(ref: string, target: string, remove: boolean, options: WriteOptions): EntityRecord {
    return this.changeLink(ref, target, remove, "dependencies", options);
  }

  related(ref: string, target: string, remove: boolean, options: WriteOptions): EntityRecord {
    return this.changeLink(ref, target, remove, "related", options);
  }

  criterion(
    ref: string,
    action: "add" | "update" | "complete" | "reopen" | "remove",
    input: Record<string, unknown>,
    options: WriteOptions,
  ): EntityRecord {
    choice(action, ["add", "update", "complete", "reopen", "remove"], "Операция с критерием");
    object(
      input,
      action === "add"
        ? ["title", "summary", "description"]
        : action === "update"
          ? ["id", "criterionId", "title", "summary", "description"]
          : ["id", "criterionId"],
      "Изменение критерия",
    );
    return this.db.transaction(() => {
      const record = this.writable(ref, options);
      const previous = taskData(record);
      if (previous.column === "done") {
        throw new RelayError("TASK_DONE", "Сначала верните задачу из done в работу", 2);
      }
      const criteria = previous.acceptanceCriteria.map((item) => ({ ...item }));
      if (action === "add") {
        if (criteria.length >= 100) invalid("В задаче допускается не более 100 критериев");
        criteria.push(newCriterion(input));
      } else {
        if (input.id !== undefined && input.criterionId !== undefined)
          invalid("Передайте только id или criterionId");
        const id = reference(input.id ?? input.criterionId, "ID критерия");
        const index = criteria.findIndex((item) => item.id === id);
        const criterion = criteria[index];
        if (!criterion) throw new RelayError("NOT_FOUND", "Критерий не найден", 3, { id });
        if (action === "remove") criteria.splice(index, 1);
        if (action === "update") {
          const fields = ["title", "summary", "description"] as const;
          if (!fields.some((field) => input[field] !== undefined))
            invalid("Передайте хотя бы одно текстовое поле критерия");
          const content = criterionContent(
            Object.fromEntries(fields.map((field) => [field, input[field] ?? criterion[field]])),
          );
          if (fields.some((field) => content[field] !== criterion[field])) {
            Object.assign(criterion, content, {
              completed: false,
              completedAt: null,
              completedBy: null,
            });
          }
        }
        if (action === "complete" && !criterion.completed) {
          criterion.completed = true;
          criterion.completedAt = new Date().toISOString();
          criterion.completedBy = options.actor;
        }
        if (action === "reopen") {
          criterion.completed = false;
          criterion.completedAt = null;
          criterion.completedBy = null;
        }
      }
      return this.save(record, { ...previous, acceptanceCriteria: criteria }, options);
    });
  }

  comment(ref: string, body: string, actor: string, title = ""): EntityRecord {
    text(body, "Комментарий", 256 * 1024, false, true);
    text(title, "Заголовок комментария", 1024, true);
    reference(actor, "Автор");
    return this.db.transaction(() => {
      const record = this.get(ref);
      const comment: TaskComment = {
        id: randomUUID(),
        title,
        body,
        createdAt: new Date().toISOString(),
        createdBy: actor,
      };
      return this.db.appendTaskComment(record.id, comment);
    });
  }

  comments(ref: string): TaskComment[] {
    const record = this.get(ref);
    const comments = record.data.comments ?? [];
    if (!Array.isArray(comments))
      throw new RelayError("CORRUPT_DATA", "Повреждены комментарии задачи", 1);
    for (const value of comments) {
      if (
        !value ||
        typeof value !== "object" ||
        ["id", "title", "body", "createdAt", "createdBy"].some(
          (field) => typeof value[field] !== "string",
        )
      ) {
        throw new RelayError("CORRUPT_DATA", "Повреждён комментарий задачи", 1);
      }
    }
    return comments as TaskComment[];
  }

  getComment(ref: string, id: string): TaskComment {
    reference(id, "ID комментария");
    const comment = this.comments(ref).find((item) => item.id === id);
    if (!comment) throw new RelayError("NOT_FOUND", "Комментарий не найден", 3, { id });
    return comment;
  }

  progress(ref: string): TaskProgress {
    return this.db.snapshot(() => {
      const record = this.get(ref);
      return this.graph().progress(record.id);
    });
  }

  children(ref: string): EntityRecord[] {
    return this.list({ parent: ref });
  }

  dependencies(ref: string): EntityRecord[] {
    return this.db.snapshot(() => taskData(this.get(ref)).dependencies.map((id) => this.get(id)));
  }

  criteria(ref: string): TaskCriterion[] {
    return taskData(this.get(ref)).acceptanceCriteria;
  }

  getCriterion(ref: string, id: string): TaskCriterion {
    reference(id, "ID критерия");
    const criterion = this.criteria(ref).find((item) => item.id === id);
    if (!criterion) throw new RelayError("NOT_FOUND", "Критерий не найден", 3, { id });
    return criterion;
  }

  private writable(ref: string, options: WriteOptions): EntityRecord {
    object(options, ["actor", "ifRevision"], "Параметры записи");
    reference(options.actor, "Автор");
    if (!Number.isSafeInteger(options.ifRevision) || options.ifRevision < 1)
      invalid("Нужна положительная целая ifRevision");
    const record = this.get(ref);
    if (record.revision !== options.ifRevision) {
      throw new RelayError(
        "REVISION_CONFLICT",
        "Задача изменена: перечитайте её перед записью",
        4,
        {
          id: record.id,
          expectedRevision: options.ifRevision,
          actualRevision: record.revision,
        },
      );
    }
    return record;
  }

  private save(record: EntityRecord, data: TaskData, options: WriteOptions): EntityRecord {
    if (same(record.data, data)) return record;
    return this.entities.update(record.id, "task", data, options);
  }

  private board(ref: string): EntityRecord {
    const direct = this.db.get(ref, "board");
    if (direct) return direct;
    const matches = this.db
      .list("board")
      .filter((board) => board.data.slug === ref || board.data.prefix === ref);
    if (matches.length > 1) invalid(`Неоднозначная ссылка на доску: ${ref}`);
    if (matches[0]) return matches[0];
    throw new RelayError("NOT_FOUND", `Доска не найдена: ${ref}`, 3);
  }

  private prefix(board: EntityRecord): string {
    const value = board.data.prefix;
    if (typeof value !== "string" || !/^[A-Z][A-Z0-9-]*$/u.test(value)) {
      throw new RelayError("CORRUPT_DATA", `У доски ${board.key} некорректный префикс задач`, 1);
    }
    return value;
  }

  private taskReferences(value: unknown, name: string): string[] {
    const ids = array(value, name, 200).map((ref) => this.get(reference(ref, name)).id);
    if (new Set(ids).size !== ids.length) invalid(`${name}: повторяющиеся задачи недопустимы`);
    return ids;
  }

  private targets(value: unknown, board: EntityRecord, retained: string[]): string[] {
    const records = array(value, "Цели реализации", 100).map((ref) =>
      this.entities.get(reference(ref, "Цель реализации")),
    );
    const ids = records.map((record) => record.id);
    if (new Set(ids).size !== ids.length) invalid("Цели реализации не должны повторяться");
    for (const target of records) {
      const applicationId = board.data.applicationId;
      if (typeof applicationId === "string") {
        if (target.kind !== "implementation" || target.data.applicationId !== applicationId) {
          invalid("На доске приложения допустимы только реализации собственного приложения");
        }
        if (target.data.active !== true && !retained.includes(target.id)) {
          invalid("Снятая реализация не допускает нового назначения");
        }
      } else if (board.data.slug === "product") {
        if (target.kind !== "feature" && target.kind !== "scenario") {
          invalid("На продуктовой доске допустимы только фичи и сценарии");
        }
      } else {
        invalid("Эта доска не допускает целей реализации");
      }
    }
    return ids;
  }

  private targetScope(ref: string, expanded: boolean): Set<string> {
    const target = this.entities.get(ref);
    if (!["feature", "scenario", "implementation"].includes(target.kind))
      invalid("Нужна фича, сценарий или реализация");
    const ids = new Set([target.id]);
    if (!expanded) return ids;
    if (target.kind === "implementation") {
      const requirement = this.entities.get(reference(target.data.targetId, "Цель реализации"));
      if (requirement.kind === "feature") {
        const scenarios = new Set(
          this.db
            .list("scenario")
            .filter((item) => item.data.featureId === requirement.id)
            .map((item) => item.id),
        );
        for (const implementation of this.db.list("implementation")) {
          if (
            implementation.data.active === true &&
            implementation.data.applicationId === target.data.applicationId &&
            typeof implementation.data.targetId === "string" &&
            scenarios.has(implementation.data.targetId)
          ) {
            ids.add(implementation.id);
          }
        }
      }
      return ids;
    }
    if (target.kind === "feature") {
      for (const scenario of this.db.list("scenario")) {
        if (scenario.data.featureId === target.id) ids.add(scenario.id);
      }
    }
    for (const implementation of this.db.list("implementation")) {
      if (
        implementation.data.active === true &&
        typeof implementation.data.targetId === "string" &&
        ids.has(implementation.data.targetId)
      ) {
        ids.add(implementation.id);
      }
    }
    return ids;
  }

  private graph(candidate?: EntityRecord): TaskGraph {
    const records = this.db.list("task");
    return new TaskGraph(
      candidate ? [...records.filter((item) => item.id !== candidate.id), candidate] : records,
    );
  }

  private ensureDone(record: EntityRecord, graph: TaskGraph): void {
    if (taskData(record).column === "done" && !graph.progress(record.id).canComplete) {
      throw new RelayError(
        "TASK_INCOMPLETE",
        "Завершение требует выполнения критериев, детей и зависимостей",
        2,
        {
          id: record.id,
          blockers: graph.progress(record.id).blockers,
        },
      );
    }
  }

  private ensureParentAccepts(
    record: EntityRecord,
    previousParent: string | null,
    graph: TaskGraph,
  ): void {
    const parentId = taskData(record).parentId;
    if (
      parentId &&
      parentId !== previousParent &&
      graph.data.get(parentId)!.column === "done" &&
      !graph.progress(record.id).completed
    ) {
      throw new RelayError(
        "TASK_DONE",
        "Для добавления невыполненного ребёнка верните родителя из done в работу",
        2,
      );
    }
  }

  private changeLink(
    ref: string,
    target: string,
    remove: boolean,
    field: "dependencies" | "related",
    options: WriteOptions,
  ): EntityRecord {
    if (typeof remove !== "boolean") invalid("remove должен быть логическим значением");
    return this.db.transaction(() => {
      const record = this.writable(ref, options);
      const targetRecord = this.get(reference(target, "Связанная задача"));
      if (record.id === targetRecord.id) invalid("Самоссылка задачи запрещена");
      const previous = taskData(record);
      const values = previous[field];
      const next = remove
        ? values.filter((id) => id !== targetRecord.id)
        : [...new Set([...values, targetRecord.id])];
      if (next.length > 200) invalid("В задаче допускается не более 200 связей каждого вида");
      const data = { ...previous, [field]: next };
      const candidate = { ...record, data };
      const graph = this.graph(candidate);
      if (field === "dependencies" && !remove && !values.includes(targetRecord.id))
        this.ensureDone(candidate, graph);
      return this.save(record, data, options);
    });
  }
}
