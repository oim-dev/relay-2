import { randomUUID } from "node:crypto";
import {
  RelayError,
  validateActor,
  validateEntityPageRequest,
  type EntityPage,
  type EntityPageRequest,
  type EntityRecord,
  type TaskComment,
  type TaskCriterion,
  type TaskData,
  type TaskProgress,
  type TaskRecord,
  type WriteOptions,
} from "@relay/contracts";
import type { ProjectDatabase } from "@relay/storage";
import { EntityService } from "./entities";
import { pageEntities } from "./entity-page";
import { taskGraphNode, taskRecord } from "./task-data";
import { TaskGraph } from "./task-graph";
import {
  array,
  choice,
  column,
  criterionContent,
  invalid,
  newCriterion,
  object,
  reference,
  text,
} from "./task-input";
import { selectTaskRecords, type TaskSelection } from "./task-list";

export {
  TASK_COLUMNS,
  type TaskColumn,
  type TaskComment,
  type TaskCriterion,
  type TaskProgress,
} from "@relay/contracts";

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Локальные сценарии задач: декодирование, проверки и запись атомарны в пределах проекта.
 * Мутации содержания принимают ifRevision самой задачи и проверяют CAS до no-op.
 * Комментарии имеют независимый append-only журнал и не изменяют эту ревизию.
 */
export class TasksService {
  private readonly db: ProjectDatabase;
  private readonly entities: EntityService;

  constructor(db: ProjectDatabase) {
    this.db = db;
    this.entities = new EntityService(db);
  }

  get(ref: string): TaskRecord {
    return taskRecord(this.entities.get(reference(ref, "Задача"), "task"));
  }

  list(filters: Record<string, unknown> = {}): TaskRecord[] {
    return this.db.snapshot(() => {
      const selection = this.prepareFilters(filters);
      return selectTaskRecords(this.db.list("task").map(taskRecord), selection);
    });
  }

  /**
   * Страница и total относятся к одному снимку. Без фильтров SQL читает только окно;
   * остальные карточки и их журналы не загружаются. Фильтрованный запрос пока читает
   * весь набор: поиск использует содержание, readiness — общий граф обязательств.
   * Для фильтрованной страницы limit ограничивает выдачу, но не стоимость чтения.
   */
  listPage(filters: Record<string, unknown>, request: EntityPageRequest): EntityPage<TaskRecord> {
    validateEntityPageRequest(request);
    return this.db.snapshot(() => {
      const selection = this.prepareFilters(filters);
      if (Object.keys(filters).length === 0) {
        const page = this.db.listPage("task", request);
        return { items: page.items.map(taskRecord), total: page.total };
      }
      return pageEntities(
        selectTaskRecords(this.db.list("task").map(taskRecord), selection),
        request,
      );
    });
  }

  private prepareFilters(filters: Record<string, unknown>): TaskSelection {
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
    const query = filters.q === undefined ? "" : text(filters.q, "Поиск", 1024).toLocaleLowerCase();
    const readiness =
      filters.readiness === undefined
        ? undefined
        : choice(filters.readiness, ["ready", "blocked"], "Готовность");
    const target = filters.target ?? filters.productTarget;
    const targetIds =
      target === undefined
        ? undefined
        : this.targetScope(reference(target, "Цель"), filters.productTarget !== undefined);
    return {
      boardId,
      column: selectedColumn,
      parentId,
      completion,
      searchIn,
      query,
      readiness,
      targetIds,
    };
  }

  create(input: Record<string, unknown>, actor: string): TaskRecord {
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
    validateActor(actor);
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
        comments: [],
      };
      const record = taskRecord(this.entities.create("task", this.prefix(board), data, actor));
      const graph = this.graph(record);
      this.ensureDone(record, graph);
      this.ensureParentAccepts(record, null, graph);
      return record;
    });
  }

  update(ref: string, input: Record<string, unknown>, options: WriteOptions): TaskRecord {
    object(input, ["title", "description", "targets"], "Обновление задачи");
    if (Object.keys(input).length === 0) invalid("Передайте хотя бы одно поле задачи");
    return this.db.transaction(() => {
      const record = this.writable(ref, options);
      const data = { ...record.data };
      if (input.title !== undefined) data.title = text(input.title, "Заголовок задачи", 1024, true);
      if (input.description !== undefined)
        data.description = text(input.description, "Описание задачи", 256 * 1024);
      if (input.targets !== undefined)
        data.targets = this.targets(input.targets, this.board(data.boardId), data.targets);
      return this.save(record, data, options);
    });
  }

  /**
   * Атомарно меняет доску/колонку; CAS принадлежит задаче. Перенос на другую доску
   * выдаёт новый ключ и сохраняет прежний алиас. Done требует выполненных обязательств.
   * Неизменный запрос сохраняет ревизию, но не обходит CAS и проверку графа.
   */
  move(ref: string, input: Record<string, unknown>, options: WriteOptions): TaskRecord {
    object(input, ["board", "column"], "Перенос задачи");
    if (Object.keys(input).length === 0) invalid("Передайте доску или колонку");
    return this.db.transaction(() => {
      const record = this.writable(ref, options);
      const previous = record.data;
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
      const moved: TaskRecord = {
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

  setParent(ref: string, parent: string | null, options: WriteOptions): TaskRecord {
    return this.db.transaction(() => {
      const record = this.writable(ref, options);
      const previous = record.data;
      const parentId = parent === null ? null : this.get(reference(parent, "Родитель")).id;
      const data = { ...previous, parentId };
      const candidate = { ...record, data };
      const graph = this.graph(candidate);
      this.ensureParentAccepts(candidate, previous.parentId, graph);
      return this.save(record, data, options);
    });
  }

  dependency(ref: string, target: string, remove: boolean, options: WriteOptions): TaskRecord {
    return this.changeLink(ref, target, remove, "dependencies", options);
  }

  related(ref: string, target: string, remove: boolean, options: WriteOptions): TaskRecord {
    return this.changeLink(ref, target, remove, "related", options);
  }

  /**
   * Меняет критерий под CAS задачи. Изменение текста сбрасывает отметку выполнения;
   * неизменный текст — no-op после CAS. В done изменения критериев запрещены.
   */
  criterion(
    ref: string,
    action: "add" | "update" | "complete" | "reopen" | "remove",
    input: Record<string, unknown>,
    options: WriteOptions,
  ): TaskRecord {
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
      const previous = record.data;
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

  /**
   * Атомарно дописывает неизменяемый комментарий в отдельный append-only журнал.
   * CAS содержания не требуется: revision/updatedAt/updatedBy задачи не меняются,
   * поколение проекта увеличивается. Поздняя запись содержания не стирает журнал.
   * Каждый вызов публикует новый комментарий; повтор не является no-op.
   */
  comment(ref: string, body: string, actor: string, title = ""): TaskRecord {
    text(body, "Комментарий", 256 * 1024, false, true);
    text(title, "Заголовок комментария", 1024, true);
    validateActor(actor);
    return this.db.transaction(() => {
      const record = this.get(ref);
      const comment: TaskComment = {
        id: randomUUID(),
        title,
        body,
        createdAt: new Date().toISOString(),
        createdBy: actor,
      };
      return taskRecord(this.db.appendTaskComment(record.id, comment));
    });
  }

  comments(ref: string): TaskComment[] {
    return this.get(ref).data.comments;
  }

  getComment(ref: string, id: string): TaskComment {
    reference(id, "ID комментария");
    const comment = this.comments(ref).find((item) => item.id === id);
    if (!comment) throw new RelayError("NOT_FOUND", "Комментарий не найден", 3, { id });
    return comment;
  }

  progress(ref: string): TaskProgress {
    return this.progressMany([ref]).values().next().value!;
  }

  /**
   * Вычисляет прогресс набора в одном согласованном снимке с одним общим графом.
   * ID, ключи, алиасы и типизированные ссылки разрешаются в постоянные ID — ключи Map;
   * одинаковые входные строки разрешаются один раз, алиасы одной задачи дают один результат.
   * Разрешение ссылок не читает содержание и комментарии. Пустой набор не читает граф.
   * Вложенный вызов наследует снимок/транзакцию вызывающего сценария; кеша между вызовами нет.
   * Проверяются поля обязательств, полное содержание карточек для расчёта не требуется.
   * Цикл, повреждённое поле графа или отсутствующее обязательство отвергают весь расчёт.
   */
  progressMany(refs: readonly string[]): Map<string, TaskProgress> {
    return this.db.snapshot(() => {
      const ids = new Set(
        [...new Set(refs)].map((ref) => this.entities.resolve(reference(ref, "Задача"), "task").id),
      );
      if (ids.size === 0) return new Map();
      const graph = this.graph();
      return new Map([...ids].map((id) => [id, graph.progress(id)]));
    });
  }

  children(ref: string): TaskRecord[] {
    return this.list({ parent: ref });
  }

  dependencies(ref: string): TaskRecord[] {
    return this.db.snapshot(() => this.get(ref).data.dependencies.map((id) => this.get(id)));
  }

  criteria(ref: string): TaskCriterion[] {
    return this.get(ref).data.acceptanceCriteria;
  }

  getCriterion(ref: string, id: string): TaskCriterion {
    reference(id, "ID критерия");
    const criterion = this.criteria(ref).find((item) => item.id === id);
    if (!criterion) throw new RelayError("NOT_FOUND", "Критерий не найден", 3, { id });
    return criterion;
  }

  private writable(ref: string, options: WriteOptions): TaskRecord {
    object(options, ["actor", "ifRevision"], "Параметры записи");
    validateActor(options.actor);
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

  private save(record: TaskRecord, data: TaskData, options: WriteOptions): TaskRecord {
    if (same(record.data, data)) return record;
    return taskRecord(this.entities.update(record.id, "task", data, options));
  }

  private board(ref: string): EntityRecord {
    return this.entities.get(ref, "board");
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

  private graph(candidate?: TaskRecord): TaskGraph {
    const records = this.db.listTaskGraph();
    return new TaskGraph(
      (candidate
        ? [...records.filter((item) => item.id !== candidate.id), candidate]
        : records
      ).map(taskGraphNode),
    );
  }

  private ensureDone(record: TaskRecord, graph: TaskGraph): void {
    if (record.data.column === "done" && !graph.progress(record.id).canComplete) {
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
    record: TaskRecord,
    previousParent: string | null,
    graph: TaskGraph,
  ): void {
    const parentId = record.data.parentId;
    if (
      parentId &&
      parentId !== previousParent &&
      graph.column(parentId) === "done" &&
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
  ): TaskRecord {
    if (typeof remove !== "boolean") invalid("remove должен быть логическим значением");
    return this.db.transaction(() => {
      const record = this.writable(ref, options);
      const targetRecord = this.get(reference(target, "Связанная задача"));
      if (record.id === targetRecord.id) invalid("Самоссылка задачи запрещена");
      const previous = record.data;
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
