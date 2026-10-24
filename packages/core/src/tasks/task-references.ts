/**
 * Разрешение ссылок задач и раскрытие продуктовых целей в снимке вызывающего сценария.
 * Данные знаний декодирует их владелец; допустимость назначения определяют чистые правила задач.
 */
import { RelayError, type KnowledgeRecord, type TaskRecord } from "@relay/contracts";
import type { ProjectStore } from "@relay/storage";
import type { EntityService } from "../entities/entities";
import { decodeKnowledge } from "../knowledge/knowledge-data";
import { taskRecord } from "./task-data";
import type { TaskTarget } from "./task-data.types";
import type { TaskFilterInput, TaskTargetFilter } from "./task-input.types";
import type { TaskSelection } from "./task-list.types";
import { taskMessages } from "./task-messages";

/**
 * Чтение адресованных сущностей без кеша между операциями; ресурсами БД владеет вызывающий сервис.
 */
export class TaskReferences {
  /* Соединение проекта; составные чтения выполняются внутри снимка сервиса. */
  private readonly db: ProjectStore;
  /* Общий владелец разрешения ID, ключей, алиасов и типизированных ссылок. */
  private readonly entities: EntityService;

  /**
   * Привязывает разрешение ссылок к существующему соединению, не открывая новых ресурсов.
   */
  constructor(db: ProjectStore, entities: EntityService) {
    this.db = db;
    this.entities = entities;
  }

  /**
   * Читает и полностью декодирует задачу по проверенной пользовательской ссылке.
   */
  task(ref: string): TaskRecord {
    return taskRecord(this.entities.get(ref, "task"));
  }

  /**
   * Читает доску через декодер знаний, включая проверку сохранённого префикса задач.
   */
  board(ref: string): KnowledgeRecord<"board"> {
    return decodeKnowledge(this.entities.get(ref, "board"), "board");
  }

  /**
   * Разрешает фильтры в текущем снимке без чтения полного списка задач.
   */
  selection(input: TaskFilterInput): TaskSelection {
    const boardId = input.board === undefined ? undefined : this.board(input.board).id;
    let parentId = input.parent;
    if (parentId !== undefined && parentId !== null) {
      parentId = this.task(parentId).id;
    }
    return {
      boardId,
      column: input.column,
      parentId,
      completion: input.completion,
      searchIn: input.searchIn,
      query: input.query,
      readiness: input.readiness,
      targetIds: input.target === undefined ? undefined : this.targetScope(input.target),
    };
  }

  /**
   * Декодирует допустимый вид цели либо отвергает ссылку на другую предметную сущность.
   */
  private target(ref: string): TaskTarget {
    const record = this.entities.get(ref);
    switch (record.kind) {
      case "feature":
      case "scenario":
      case "implementation":
        return decodeKnowledge(record, record.kind);
      default:
        throw new RelayError("INVALID_ARGUMENT", taskMessages.targetKind, 2);
    }
  }

  /**
   * Получает ID сценариев одной фичи из одного чтения набора сценариев текущего снимка.
   */
  private scenarioIds(featureId: string): Set<string> {
    const scenarios = this.db.list("scenario").map((record) => decodeKnowledge(record, "scenario"));
    return new Set(
      scenarios.filter((record) => record.data.featureId === featureId).map((record) => record.id),
    );
  }

  /**
   * Раскрывает продуктовую цель одним чтением каждого нужного набора знаний.
   * Для реализации фичи добавляет только активные реализации её сценариев того же приложения.
   * Исходная цель остаётся в области независимо от активности; глобального кеша нет.
   */
  private targetScope(filter: TaskTargetFilter): Set<string> {
    const target = this.target(filter.reference);
    const ids = new Set([target.id]);
    if (filter.scope === "direct") {
      return ids;
    }
    if (target.kind === "implementation") {
      const requirement = this.target(target.data.targetId);
      if (requirement.kind !== "feature") {
        return ids;
      }
      const scenarios = this.scenarioIds(requirement.id);
      for (const record of this.db.list("implementation")) {
        const implementation = decodeKnowledge(record, "implementation");
        if (
          implementation.data.active &&
          implementation.data.applicationId === target.data.applicationId &&
          scenarios.has(implementation.data.targetId)
        ) {
          ids.add(implementation.id);
        }
      }
      return ids;
    }
    if (target.kind === "feature") {
      for (const id of this.scenarioIds(target.id)) {
        ids.add(id);
      }
    }
    for (const record of this.db.list("implementation")) {
      const implementation = decodeKnowledge(record, "implementation");
      if (implementation.data.active && ids.has(implementation.data.targetId)) {
        ids.add(implementation.id);
      }
    }
    return ids;
  }
}
