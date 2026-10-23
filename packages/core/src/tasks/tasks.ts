import { randomUUID } from "node:crypto";
import {
  RelayError,
  validateActor,
  validateEntityPageRequest,
  type EntityPage,
  type EntityPageRequest,
  type TaskComment,
  type TaskCriterion,
  type TaskData,
  type TaskProgress,
  type TaskRecord,
  type WriteOptions,
} from "@relay/contracts";
import type { ProjectDatabase } from "@relay/storage";
import { EntityService } from "../entities/entities";
import { pageEntities } from "../entities/entity-page";
import { TASK_LIMITS } from "./task-constants";
import { changeTaskCriteria, findTaskCriterion } from "./task-criteria";
import { parseTaskCriterionChange } from "./task-criterion-input";
import { taskGraphNode, taskRecord } from "./task-data";
import { TaskGraph } from "./task-graph";
import {
  parseCreateTask,
  parseMoveTask,
  parseTaskFilters,
  parseTaskLink,
  parseUpdateTask,
  reference,
  text,
  validateTaskWriteOptions,
} from "./task-input";
import type { TaskCriterionAction, TaskLinkChange } from "./task-input.types";
import { selectTaskRecords } from "./task-list";
import { taskLabels, taskMessages } from "./task-messages";
import { TaskReferences } from "./task-references";
import type { TaskCollection, TaskCriterionRead } from "./task-read.types";
import {
  changeTaskLink,
  ensureTaskDone,
  ensureTaskParentAccepts,
  sameTaskData,
} from "./task-rules";

export {
  TASK_COLUMNS,
  type TaskColumn,
  type TaskComment,
  type TaskCriterion,
  type TaskProgress,
} from "@relay/contracts";

/**
 * Локальные сценарии задач: декодирование, проверки и запись атомарны в пределах проекта.
 * Мутации содержания принимают ifRevision самой задачи и проверяют CAS до no-op.
 * Комментарии имеют независимый append-only журнал и не изменяют эту ревизию.
 */
export class TasksService {
  /* Соединение проекта; его жизненным циклом владеет вызывающее приложение. */
  private readonly db: ProjectDatabase;
  /* Внутренний примитив разрешения адресов и записи проверенного содержания. */
  private readonly entities: EntityService;
  /* Разрешение задач, досок и целей без кеша между снимками. */
  private readonly references: TaskReferences;

  /**
   * Создаёт сервис поверх открытой БД, не открывая дополнительных соединений.
   */
  constructor(db: ProjectDatabase) {
    this.db = db;
    this.entities = new EntityService(db);
    this.references = new TaskReferences(db, this.entities);
  }

  /**
   * Возвращает полную карточку и журнал из снимка разрешения ID, ключа либо алиаса задачи.
   * Отсутствующая задача даёт NOT_FOUND, неверное сохранённое содержание — CORRUPT_DATA.
   */
  get(ref: string): TaskRecord {
    return this.references.task(reference(ref, taskLabels.task));
  }

  /**
   * Отбирает задачи в одном снимке, загружая все карточки с журналами.
   * Вычисляемая готовность использует один общий граф; порядок совпадает с порядком Storage.
   */
  list(filters: Readonly<Record<string, unknown>> = {}): TaskRecord[] {
    const input = parseTaskFilters(filters);
    return this.db.snapshot(() => {
      const selection = this.references.selection(input);
      return selectTaskRecords(this.db.list("task").map(taskRecord), selection);
    });
  }

  /**
   * Страница и total относятся к одному снимку. Без фильтров SQL читает только окно;
   * остальные карточки и их журналы не загружаются. Фильтрованный запрос пока читает
   * весь набор: поиск использует содержание, readiness — общий граф обязательств.
   * Для фильтрованной страницы limit ограничивает выдачу, но не стоимость чтения.
   */
  listPage(
    filters: Readonly<Record<string, unknown>>,
    request: EntityPageRequest,
  ): EntityPage<TaskRecord> {
    validateEntityPageRequest(request);
    const input = parseTaskFilters(filters);
    return this.db.snapshot(() => {
      if (input.unfiltered) {
        const page = this.db.listPage("task", request);
        return { items: page.items.map(taskRecord), total: page.total };
      }
      const selection = this.references.selection(input);
      return pageEntities(
        selectTaskRecords(this.db.list("task").map(taskRecord), selection),
        request,
      );
    });
  }

  /**
   * Атомарно создаёт задачу с разрешёнными ссылками и проверенным графом обязательств.
   * Невозможный done, цикл и невыполненный новый ребёнок done-родителя откатывают также ключ и поколение.
   */
  create(input: Readonly<Record<string, unknown>>, actor: string): TaskRecord {
    const command = parseCreateTask(input);
    validateActor(actor);
    return this.db.transaction(() => {
      const board = this.references.board(command.board);
      const data: TaskData = {
        boardId: board.id,
        title: command.title,
        description: command.description,
        column: command.column,
        parentId: command.parent === null ? null : this.references.task(command.parent).id,
        dependencies: this.references.taskIds(command.dependencies, taskLabels.dependencies),
        related: this.references.taskIds(command.related, taskLabels.related),
        targets: this.references.targets(command.targets, board, []),
        acceptanceCriteria: [...command.acceptanceCriteria],
        comments: [],
      };
      const record = taskRecord(
        this.entities.create("task", board.data.prefix, { ...data }, actor),
      );
      const graph = this.graph(record);
      ensureTaskDone(record, graph);
      ensureTaskParentAccepts(record, null, graph);
      return record;
    });
  }

  /**
   * Меняет заголовок, описание и цели под CAS задачи в общей транзакции проверки и записи.
   * Неизменное содержание сохраняет ревизию; снятая цель может остаться в прежнем назначении.
   */
  update(ref: string, input: Readonly<Record<string, unknown>>, options: WriteOptions): TaskRecord {
    const command = parseUpdateTask(input);
    return this.db.transaction(() => {
      const record = this.writable(ref, options);
      const data: TaskData = {
        ...record.data,
        title: command.title ?? record.data.title,
        description: command.description ?? record.data.description,
      };
      if (command.targets !== undefined) {
        data.targets = this.references.targets(
          command.targets,
          this.references.board(data.boardId),
          data.targets,
        );
      }
      return this.save(record, data, options);
    });
  }

  /**
   * Атомарно меняет доску/колонку; CAS принадлежит задаче. Перенос на другую доску
   * выдаёт новый ключ и сохраняет прежний алиас. Done требует выполненных обязательств.
   * Неизменный запрос сохраняет ревизию, но не обходит CAS и проверку графа.
   */
  move(ref: string, input: Readonly<Record<string, unknown>>, options: WriteOptions): TaskRecord {
    const command = parseMoveTask(input);
    return this.db.transaction(() => {
      const record = this.writable(ref, options);
      const previous = record.data;
      const board = this.references.board(command.board ?? previous.boardId);
      const data: TaskData = {
        ...previous,
        boardId: board.id,
        column: command.column ?? previous.column,
      };
      this.references.targets(
        data.targets,
        board,
        board.id === previous.boardId ? previous.targets : [],
      );
      const candidate = { ...record, data };
      ensureTaskDone(candidate, this.graph(candidate));
      if (board.id === previous.boardId) {
        return this.save(record, data, options);
      }
      // Storage резервирует прежний ключ как алиас при атомарном изменении записи.
      const moved: TaskRecord = {
        ...record,
        data,
        key: this.db.nextKey(board.data.prefix),
        revision: record.revision + 1,
        updatedAt: new Date().toISOString(),
        updatedBy: options.actor,
      };
      this.db.update({ ...moved, data: { ...moved.data } }, options.ifRevision);
      return moved;
    });
  }

  /**
   * Атомарно меняет родителя под CAS задачи; null снимает связь, прежний родитель даёт no-op.
   * Общий граф отвергает циклы и присоединение невыполненного ребёнка к done-родителю.
   */
  setParent(ref: string, parent: string | null, options: WriteOptions): TaskRecord {
    return this.db.transaction(() => {
      const record = this.writable(ref, options);
      const parentId =
        parent === null ? null : this.references.task(reference(parent, taskLabels.parent)).id;
      const data = { ...record.data, parentId };
      const candidate = { ...record, data };
      const graph = this.graph(candidate);
      ensureTaskParentAccepts(candidate, record.data.parentId, graph);
      return this.save(record, data, options);
    });
  }

  /**
   * Добавляет либо снимает обязательную зависимость атомарно под CAS задачи.
   * Повтор связи — no-op; новая зависимость done-задачи должна быть выполнена, циклы запрещены.
   */
  dependency(ref: string, target: string, remove: boolean, options: WriteOptions): TaskRecord {
    return this.changeLink(ref, parseTaskLink("dependencies", target, remove), options);
  }

  /**
   * Добавляет либо снимает необязательную связь под CAS задачи; на прогресс она не влияет.
   * Повтор связи — no-op, самоссылки запрещены; существующий граф также проверяется перед записью.
   */
  related(ref: string, target: string, remove: boolean, options: WriteOptions): TaskRecord {
    return this.changeLink(ref, parseTaskLink("related", target, remove), options);
  }

  /**
   * Атомарно меняет критерий под CAS задачи. Изменение текста сбрасывает отметку выполнения;
   * неизменный текст и повтор отметки — no-op после CAS. В done изменения критериев запрещены.
   */
  criterion(
    ref: string,
    action: TaskCriterionAction,
    input: Readonly<Record<string, unknown>>,
    options: WriteOptions,
  ): TaskRecord {
    const command = parseTaskCriterionChange(action, input);
    return this.db.transaction(() => {
      const record = this.writable(ref, options);
      const acceptanceCriteria = changeTaskCriteria(record.data, command, {
        actor: options.actor,
        timestamp: new Date().toISOString(),
      });
      return this.save(record, { ...record.data, acceptanceCriteria }, options);
    });
  }

  /**
   * Атомарно дописывает неизменяемый комментарий в отдельный append-only журнал.
   * CAS содержания не требуется: revision/updatedAt/updatedBy задачи не меняются,
   * поколение проекта увеличивается. Поздняя запись содержания не стирает журнал.
   * Каждый вызов публикует новый комментарий; повтор не является no-op.
   */
  comment(ref: string, body: string, actor: string, title = ""): TaskRecord {
    const checkedBody = text(body, taskLabels.commentBody, TASK_LIMITS.commentBody, {
      required: true,
    });
    const checkedTitle = text(title, taskLabels.commentTitle, TASK_LIMITS.commentTitle, {
      singleLine: true,
    });
    validateActor(actor);
    return this.db.transaction(() => {
      const record = this.get(ref);
      const comment: TaskComment = {
        id: randomUUID(),
        title: checkedTitle,
        body: checkedBody,
        createdAt: new Date().toISOString(),
        createdBy: actor,
      };
      return taskRecord(this.db.appendTaskComment(record.id, comment));
    });
  }

  /**
   * Возвращает журнал в порядке публикации из одного снимка карточки задачи.
   */
  comments(ref: string): TaskComment[] {
    return this.commentsWithOwner(ref).items;
  }

  /**
   * Возвращает весь независимый журнал в порядке публикации вместе с ключом и ревизией задачи.
   * Полная карточка с журналом читается и проверяется один раз в общем снимке;
   * отсутствие задачи даёт NOT_FOUND, повреждение содержания — CORRUPT_DATA.
   */
  commentsWithOwner(ref: string): TaskCollection<TaskComment> {
    return this.db.snapshot(() => {
      const task = this.get(ref);
      return { task: task.key, revision: task.revision, items: task.data.comments };
    });
  }

  /**
   * Находит комментарий по постоянному ID внутри задачи либо возвращает NOT_FOUND.
   */
  getComment(ref: string, id: string): TaskComment {
    reference(id, taskLabels.commentId);
    const comment = this.comments(ref).find((item) => item.id === id);
    if (comment === undefined) {
      throw new RelayError("NOT_FOUND", taskMessages.commentNotFound, 3, { id });
    }
    return comment;
  }

  /**
   * Вычисляет прогресс одной задачи в согласованном снимке через общий расчёт графа проекта.
   */
  progress(ref: string): TaskProgress {
    const [progress] = this.progressMany([ref]).values();
    if (progress === undefined) {
      throw new RelayError("NOT_FOUND", taskMessages.taskNotFound, 3, { ref });
    }
    return progress;
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
        [...new Set(refs)].map(
          (ref) => this.entities.resolve(reference(ref, taskLabels.task), "task").id,
        ),
      );
      if (ids.size === 0) {
        return new Map();
      }
      const graph = this.graph();
      return new Map([...ids].map((id) => [id, graph.progress(id)]));
    });
  }

  /**
   * Возвращает прямых детей в одном снимке; текущая реализация загружает весь список задач.
   */
  children(ref: string): TaskRecord[] {
    return this.list({ parent: ref });
  }

  /**
   * Читает карточки прямых зависимостей в сохранённом порядке из одного снимка.
   * Отсутствующие или повреждённые задачи отвергают чтение всего состава.
   */
  dependencies(ref: string): TaskRecord[] {
    return this.dependenciesWithOwner(ref).items;
  }

  /**
   * Возвращает ключ/ревизию владельца и полные карточки прямых зависимостей из одного снимка.
   * Владелец читается один раз; все зависимости с журналами загружаются в сохранённом порядке.
   * Отсутствие задачи даёт NOT_FOUND, повреждённое содержание — CORRUPT_DATA;
   * ошибка любой зависимости отвергает весь состав. Пагинация потребителя не сокращает чтение.
   */
  dependenciesWithOwner(ref: string): TaskCollection<TaskRecord> {
    return this.db.snapshot(() => {
      const task = this.get(ref);
      const items = task.data.dependencies.map((id) => this.get(id));
      return { task: task.key, revision: task.revision, items };
    });
  }

  /**
   * Возвращает критерии в сохранённом порядке из снимка полной карточки.
   */
  criteria(ref: string): TaskCriterion[] {
    return this.criteriaWithOwner(ref).items;
  }

  /**
   * Возвращает все критерии в сохранённом порядке вместе с ключом и ревизией задачи.
   * Полная карточка с журналом читается и проверяется один раз в общем снимке;
   * отсутствие задачи даёт NOT_FOUND, повреждение содержания — CORRUPT_DATA.
   */
  criteriaWithOwner(ref: string): TaskCollection<TaskCriterion> {
    return this.db.snapshot(() => {
      const task = this.get(ref);
      return { task: task.key, revision: task.revision, items: task.data.acceptanceCriteria };
    });
  }

  /**
   * Находит критерий по постоянному ID внутри задачи либо возвращает NOT_FOUND.
   */
  getCriterion(ref: string, id: string): TaskCriterion {
    const criterionId = reference(id, taskLabels.criterionId);
    return findTaskCriterion(this.criteria(ref), criterionId);
  }

  /**
   * Находит критерий внутри задачи и возвращает его с ключом/ревизией владельца того же снимка.
   * Сначала один раз читает и проверяет полную карточку с журналом, затем проверяет ID критерия.
   * Чужой или отсутствующий критерий даёт NOT_FOUND; повреждение карточки — CORRUPT_DATA.
   */
  getCriterionWithOwner(ref: string, id: string): TaskCriterionRead {
    const { task, revision, items } = this.criteriaWithOwner(ref);
    const criterionId = reference(id, taskLabels.criterionId);
    return { task, revision, criterion: findTaskCriterion(items, criterionId) };
  }

  /**
   * Проверяет автора, CAS содержания и полную карточку внутри уже открытой транзакции.
   * Вызывается перед расчётом изменения, чтобы no-op не принимал устаревшую ревизию.
   */
  private writable(ref: string, options: WriteOptions): TaskRecord {
    validateTaskWriteOptions(options);
    const record = this.get(ref);
    if (record.revision !== options.ifRevision) {
      throw new RelayError("REVISION_CONFLICT", taskMessages.revisionConflict, 4, {
        id: record.id,
        expectedRevision: options.ifRevision,
        actualRevision: record.revision,
      });
    }
    return record;
  }

  /**
   * Записывает проверенное содержание в транзакции вызывающего сценария после writable.
   * No-op сохраняет ревизию; EntityService повторяет CAS и сохраняет независимый журнал.
   */
  private save(record: TaskRecord, data: TaskData, options: WriteOptions): TaskRecord {
    if (sameTaskData(record.data, data)) {
      return record;
    }
    return taskRecord(this.entities.update(record.id, "task", { ...data }, options));
  }

  /**
   * Читает одну узкую проекцию графа в текущем снимке, подменяя изменяемую задачу кандидатом.
   */
  private graph(candidate?: TaskRecord): TaskGraph {
    const nodes = this.db
      .listTaskGraph()
      .filter((record) => record.id !== candidate?.id)
      .map(taskGraphNode);
    if (candidate !== undefined) {
      nodes.push(taskGraphNode(candidate));
    }
    return new TaskGraph(nodes);
  }

  /**
   * Разрешает и меняет связь в общей транзакции CAS, проверки графа и записи.
   * Новое обязательство done-задачи проверяет готовность; снятие существующей связи меняет ревизию.
   * Повторное добавление и удаление отсутствующей связи — no-op только после CAS.
   */
  private changeLink(ref: string, change: TaskLinkChange, options: WriteOptions): TaskRecord {
    return this.db.transaction(() => {
      const record = this.writable(ref, options);
      const targetId = this.references.task(change.target).id;
      const data = changeTaskLink(record, targetId, change);
      const candidate = { ...record, data };
      const graph = this.graph(candidate);
      if (
        change.field === "dependencies" &&
        change.action === "add" &&
        !record.data.dependencies.includes(targetId)
      ) {
        ensureTaskDone(candidate, graph);
      }
      return this.save(record, data, options);
    });
  }
}
