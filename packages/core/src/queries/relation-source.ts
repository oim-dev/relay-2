import {
  RelayError,
  isEntityKind,
  DOCUMENT_TARGET_KINDS,
  DOCUMENT_RELATION_TYPES,
  PLAN_SCOPE_KINDS,
  historyCheckpointKinds,
  type EntityKind,
  type EntityRecord,
  type RelationViewEdge,
} from "@relay/contracts";
import { decodeEntitySummary } from "../projections/entity-summary";
import { planningTitle } from "../planning/planning-validation";
import type { RelationIndex } from "./relation-neighborhood.types";
import { relationViewMessages } from "./relation-neighborhood.messages";

/**
 * Проверяет только поля узкой raw-проекции; она не объявляется полной ProjectEntity.
 */
class RelationSourceDecoder {
  /**
   * Привязывает ошибку к исходному владельцу без чтения содержания.
   */
  constructor(
    /* Исходная raw-запись для адреса повреждённого поля. */
    private readonly record: EntityRecord,
  ) {}

  /**
   * Сообщает повреждение выбранного поля с его владельцем и исходной причиной, если она есть.
   */
  corrupt(field: string, cause?: unknown): never {
    const error = new RelayError("CORRUPT_DATA", relationViewMessages.corrupt, 1, {
      id: this.record.id,
      field,
    });
    if (cause !== undefined) {
      error.cause = cause;
    }
    throw error;
  }

  /**
   * Проверяет объект без доверия значениям его полей.
   */
  object(value: unknown, field: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      this.corrupt(field);
    }
    return value as Record<string, unknown>;
  }

  /**
   * Проверяет строку; пустой ID запрещён, пояснение может быть пустым.
   */
  text(value: unknown, field: string, empty = false): string {
    if (typeof value !== "string" || (!empty && (value.length === 0 || value !== value.trim()))) {
      this.corrupt(field);
    }
    return value;
  }

  /**
   * Проверяет сохранённый заголовок правилом планирования без нормализации пробелов.
   * Ошибка предметной валидации означает повреждение поля исходной записи.
   */
  title(value: unknown, field: string): string {
    try {
      return planningTitle(value, field);
    } catch (error) {
      if (error instanceof RelayError && error.code === "VALIDATION_ERROR") {
        this.corrupt(field, error);
      }
      throw error;
    }
  }

  /**
   * Не заменяет отсутствующий/повреждённый массив пустым набором.
   */
  array(value: unknown, field: string): unknown[] {
    if (!Array.isArray(value)) {
      this.corrupt(field);
    }
    return value;
  }

  /**
   * Проверяет коллекцию уникальных постоянных ID.
   */
  ids(value: unknown, field: string): string[] {
    const ids = this.array(value, field).map((item) => this.text(item, field));
    if (new Set(ids).size !== ids.length) {
      this.corrupt(field);
    }
    return ids;
  }
}

/**
 * Собирает только реально сохранённые поля. Технический источник не переносит body,
 * комментарии и полные критерии; декодер проверяет выбранные поля и разрешённые цели.
 * Не вычисляет готовность задач/планов и не создаёт универсальный API записи рёбер.
 */
export function relationIndex(records: readonly EntityRecord[]): RelationIndex {
  const sources = new Map(records.map((record) => [record.id, record]));
  const nodes: RelationIndex["nodes"] = new Map();
  const edges: RelationViewEdge[] = [];
  for (const record of records) {
    const data = record.data;
    const state =
      record.kind === "task"
        ? data.column
        : record.kind === "document"
          ? data.documentStatus
          : data.status;
    const summary = decodeEntitySummary({
      ...record,
      title: [
        "project",
        "product",
        "feature",
        "scenario",
        "application",
        "board",
        "document",
      ].includes(record.kind)
        ? data.name
        : data.title,
      state,
      active: data.active,
    });
    nodes.set(record.id, {
      ref: { id: record.id, kind: record.kind },
      key: record.key,
      title: summary.title,
      status: "state" in summary ? summary.state : "",
      revision: record.revision,
    });
    const decoder: RelationSourceDecoder = new RelationSourceDecoder(record);
    /**
     * Разрешает сохранённый ID в том же metadata-снимке и проверяет ожидаемый вид.
     */
    const add = (
      value: unknown,
      type: string,
      expected?: EntityKind,
      description = "",
      slot = "",
    ): void => {
      const id = decoder.text(value, type);
      const target = sources.get(id);
      if (!target || (expected !== undefined && target.kind !== expected)) {
        decoder.corrupt(type);
      }
      edges.push({
        id: JSON.stringify([record.id, type, id, slot]),
        type,
        from: { id: record.id, kind: record.kind },
        to: { id, kind: target.kind },
        description,
        revision: record.revision,
      });
    };
    switch (record.kind) {
      case "scenario":
        add(data.featureId, "part-of", "feature");
        break;
      case "application":
        add(data.boardId, "has-board", "board");
        for (const id of decoder.ids(data.implementationIds, "implementationIds")) {
          add(id, "participates", "implementation");
        }
        break;
      case "implementation": {
        add(data.applicationId, "belongs-to", "application");
        if (data.targetKind !== "feature" && data.targetKind !== "scenario") {
          decoder.corrupt("targetKind");
        }
        add(data.targetId, "implements", data.targetKind);
        break;
      }
      case "document": {
        const unique = new Set<string>();
        for (const value of decoder.array(data.relations, "relations")) {
          const relation = decoder.object(value, "relations");
          const target = decoder.object(relation.target, "relations.target");
          const type = DOCUMENT_RELATION_TYPES.find((type) => type === relation.type);
          const kind = DOCUMENT_TARGET_KINDS.find((kind) => kind === target.kind);
          if (!type || !kind) {
            decoder.corrupt("relations.type/kind");
          }
          const id = decoder.text(target.id, "relations.target.id");
          const key = JSON.stringify([id, type]);
          if (unique.has(key)) {
            decoder.corrupt("relations.duplicate");
          }
          unique.add(key);
          add(id, type, kind, decoder.text(relation.description, "relations.description", true));
        }
        break;
      }
      case "task":
        add(data.boardId, "on-board", "board");
        if (data.parentId !== null) {
          add(data.parentId, "part-of", "task");
        }
        for (const id of decoder.ids(data.dependencies, "dependencies")) {
          add(id, "depends-on", "task");
        }
        for (const id of decoder.ids(data.related, "related")) {
          add(id, "related", "task");
        }
        for (const id of decoder.ids(data.targets, "targets")) {
          add(id, "affects");
        }
        break;
      case "work-plan": {
        const scopeIds = new Set<string>();
        const stageIds = new Set<string>();
        const taskIds = new Set<string>();
        for (const value of decoder.array(data.scope, "scope")) {
          const target = decoder.object(value, "scope");
          const kind = PLAN_SCOPE_KINDS.find((kind) => kind === target.kind);
          if (!kind) {
            decoder.corrupt("scope.kind");
          }
          const id = decoder.text(target.id, "scope.id");
          if (scopeIds.has(id)) {
            decoder.corrupt("scope.duplicate");
          }
          scopeIds.add(id);
          add(id, "scope", kind);
        }
        for (const value of decoder.array(data.stages, "stages")) {
          const stage = decoder.object(value, "stages");
          const id = decoder.text(stage.id, "stages.id");
          if (stageIds.has(id)) {
            decoder.corrupt("stages.duplicate");
          }
          stageIds.add(id);
          const title = decoder.title(stage.title, "stages.title");
          for (const task of decoder.ids(stage.taskIds, "stages.taskIds")) {
            if (taskIds.has(task)) {
              decoder.corrupt("stages.taskIds.duplicate");
            }
            taskIds.add(task);
            add(task, "contains", "task", title, id);
          }
        }
        break;
      }
      case "release":
        for (const id of decoder.ids(data.planIds, "planIds")) {
          add(id, "contains", "work-plan");
        }
        break;
      case "work-session":
        if (data.parentSessionId !== null) {
          add(data.parentSessionId, "part-of", "work-session");
        }
        if (data.originCheckpointId !== null) {
          add(data.originCheckpointId, "origin", "work-checkpoint");
        }
        break;
      case "work-checkpoint": {
        const referenceIds = new Set<string>();
        if (!historyCheckpointKinds.some((kind) => kind === data.kind)) {
          decoder.corrupt("kind");
        }
        add(data.sessionId, "belongs-to", "work-session");
        if (data.intentId !== null) {
          add(data.intentId, "intent", "work-checkpoint");
        }
        for (const value of decoder.array(data.references, "references")) {
          const reference = decoder.object(value, "references");
          const id = decoder.text(reference.id, "references.id");
          if (referenceIds.has(id)) {
            decoder.corrupt("references.duplicate");
          }
          referenceIds.add(id);
          if (!isEntityKind(reference.kind)) {
            decoder.corrupt("references.kind");
          }
          // Подпись исторична, но постоянный ID должен существовать по текущему контракту Core.
          add(id, "references", reference.kind);
        }
        for (const id of decoder.ids(data.acceptedSessionIds, "acceptedSessionIds")) {
          add(id, "accepts", "work-session");
        }
        break;
      }
    }
  }
  edges.sort((a, b) => a.id.localeCompare(b.id));
  return { nodes, edges };
}
