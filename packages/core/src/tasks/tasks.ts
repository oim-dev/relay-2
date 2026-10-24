import {
  RelayError,
  validateEntityPageRequest,
  type CommandExecutionContext,
  type CommandWriteOptions,
  type EntityPage,
  type EntityPageRequest,
  type TaskComment,
  type TaskCriterion,
  type TaskProgress,
  type TaskRecord,
} from "@relay/contracts";
import type { ProjectStore } from "@relay/storage";
import { executeEntityCommand } from "../commands/command-facade";
import { EntityService } from "../entities/entities";
import { pageEntities } from "../entities/entity-page";
import { findTaskCriterion } from "./task-criteria";
import { taskGraphNode, taskRecord } from "./task-data";
import { TaskGraph } from "./task-graph";
import { parseTaskFilters, parseTaskLink, reference, validateTaskWriteOptions } from "./task-input";
import type { TaskCriterionAction } from "./task-input.types";
import { selectTaskRecords } from "./task-list";
import { taskLabels, taskMessages } from "./task-messages";
import { TaskReferences } from "./task-references";
import type { TaskCollection, TaskCriterionRead } from "./task-read.types";

export {
  TASK_COLUMNS,
  type TaskColumn,
  type TaskComment,
  type TaskCriterion,
  type TaskProgress,
} from "@relay/contracts";

/**
 * Синхронные чтения задач и тонкие async фасады единственного command executor.
 * Мутации содержания принимают ifRevision и/или expectedVersion самой задачи до no-op.
 * Переносимый token проверяет общий executor; фасад не читает и не подставляет числовой CAS.
 * Комментарии имеют независимый append-only журнал и не изменяют эту ревизию.
 */
export class TasksService {
  /* Соединение проекта; его жизненным циклом владеет вызывающее приложение. */
  private readonly db: ProjectStore;
  /* Внутренний примитив разрешения адресов для синхронных чтений. */
  private readonly entities: EntityService;
  /* Разрешение задач, досок и целей без кеша между снимками. */
  private readonly references: TaskReferences;
  /* Ожидаемые адресные привязки и переносимый token по умолчанию для записей фасада. */
  private readonly execution: CommandExecutionContext;

  /**
   * Создаёт сервис поверх открытой БД, не открывая дополнительных соединений.
   */
  constructor(db: ProjectStore, execution: CommandExecutionContext = {}) {
    this.db = db;
    this.execution = execution;
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
  async create(input: Readonly<Record<string, unknown>>, actor: string): Promise<TaskRecord> {
    return taskRecord(
      await executeEntityCommand(this.db, { op: "task.create", input }, actor, this.execution),
    );
  }

  /**
   * Меняет заголовок, описание и цели через async load и атомарный guarded commit под CAS задачи.
   * Неизменное содержание сохраняет ревизию; снятая цель может остаться в прежнем назначении.
   */
  async update(
    ref: string,
    input: Readonly<Record<string, unknown>>,
    options: CommandWriteOptions,
  ): Promise<TaskRecord> {
    const conditions = validateTaskWriteOptions(options, this.execution.expectedVersion);
    return taskRecord(
      await executeEntityCommand(
        this.db,
        { op: "task.update", ref, input, ...conditions },
        options.actor,
        this.execution,
      ),
    );
  }

  /**
   * Атомарно меняет доску/колонку; CAS принадлежит задаче. Перенос на другую доску
   * выдаёт новый ключ и сохраняет прежний алиас. Done требует выполненных обязательств.
   * Неизменный запрос сохраняет ревизию, но не обходит CAS и проверку графа.
   */
  async move(
    ref: string,
    input: Readonly<Record<string, unknown>>,
    options: CommandWriteOptions,
  ): Promise<TaskRecord> {
    const conditions = validateTaskWriteOptions(options, this.execution.expectedVersion);
    return taskRecord(
      await executeEntityCommand(
        this.db,
        { op: "task.move", ref, input, ...conditions },
        options.actor,
        this.execution,
      ),
    );
  }

  /**
   * Атомарно меняет родителя под CAS задачи; null снимает связь, прежний родитель даёт no-op.
   * Общий граф отвергает циклы и присоединение невыполненного ребёнка к done-родителю.
   */
  async setParent(
    ref: string,
    parent: string | null,
    options: CommandWriteOptions,
  ): Promise<TaskRecord> {
    const conditions = validateTaskWriteOptions(options, this.execution.expectedVersion);
    return taskRecord(
      await executeEntityCommand(
        this.db,
        {
          op: parent === null ? "task.parent.clear" : "task.parent.set",
          ref,
          input: parent === null ? {} : { parent: reference(parent, taskLabels.parent) },
          ...conditions,
        },
        options.actor,
        this.execution,
      ),
    );
  }

  /**
   * Добавляет либо снимает обязательную зависимость атомарно под CAS задачи.
   * Повтор связи — no-op; новая зависимость done-задачи должна быть выполнена, циклы запрещены.
   */
  async dependency(
    ref: string,
    target: string,
    remove: boolean,
    options: CommandWriteOptions,
  ): Promise<TaskRecord> {
    const conditions = validateTaskWriteOptions(options, this.execution.expectedVersion);
    const change = parseTaskLink("dependencies", target, remove);
    return taskRecord(
      await executeEntityCommand(
        this.db,
        {
          op: `task.dependency.${change.action}`,
          ref,
          input: { target: change.target },
          ...conditions,
        },
        options.actor,
        this.execution,
      ),
    );
  }

  /**
   * Добавляет либо снимает необязательную связь под CAS задачи; на прогресс она не влияет.
   * Повтор связи — no-op, самоссылки запрещены; существующий граф также проверяется перед записью.
   */
  async related(
    ref: string,
    target: string,
    remove: boolean,
    options: CommandWriteOptions,
  ): Promise<TaskRecord> {
    const conditions = validateTaskWriteOptions(options, this.execution.expectedVersion);
    const change = parseTaskLink("related", target, remove);
    return taskRecord(
      await executeEntityCommand(
        this.db,
        {
          op: change.action === "add" ? "task.link" : "task.unlink",
          ref,
          input: { target: change.target },
          ...conditions,
        },
        options.actor,
        this.execution,
      ),
    );
  }

  /**
   * Атомарно меняет критерий под CAS задачи. Изменение текста сбрасывает отметку выполнения;
   * неизменный текст и повтор отметки — no-op после CAS. В done изменения критериев запрещены.
   */
  async criterion(
    ref: string,
    action: TaskCriterionAction,
    input: Readonly<Record<string, unknown>>,
    options: CommandWriteOptions,
  ): Promise<TaskRecord> {
    const conditions = validateTaskWriteOptions(options, this.execution.expectedVersion);
    return taskRecord(
      await executeEntityCommand(
        this.db,
        {
          op: `task.criterion.${action}`,
          ref,
          input,
          ...conditions,
        },
        options.actor,
        this.execution,
      ),
    );
  }

  /**
   * Атомарно дописывает неизменяемый комментарий в отдельный append-only журнал.
   * CAS содержания не требуется: revision/updatedAt/updatedBy задачи не меняются,
   * поколение проекта увеличивается. Поздняя запись содержания не стирает журнал.
   * Каждый вызов публикует новый комментарий; повтор не является no-op.
   */
  async comment(ref: string, body: string, actor: string, title = ""): Promise<TaskRecord> {
    return taskRecord(
      await executeEntityCommand(
        this.db,
        { op: "task.comment.add", ref, input: { title, body } },
        actor,
        this.execution,
      ),
    );
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
   * Читает одну узкую проекцию графа в текущем синхронном снимке чтения.
   */
  private graph(): TaskGraph {
    return new TaskGraph(this.db.listTaskGraph().map(taskGraphNode));
  }
}
