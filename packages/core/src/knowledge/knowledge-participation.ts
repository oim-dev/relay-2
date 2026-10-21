import { RelayError, type KnowledgeRecord } from "@relay/contracts";
import type { EntityService } from "../entities/entities";
import { decodeKnowledge } from "./knowledge-data";
import type { KnowledgeQueries } from "./knowledge-queries";
import {
  requireFeatureParticipation,
  requireImplementationTarget,
  requireParticipationSelection,
  sameKnowledgeCollection,
} from "./knowledge-rules";
import { knowledgeMessages } from "./knowledge.messages";
import type { ImplementationContent, ImplementationTarget } from "./knowledge.types";
import { invalidKnowledge } from "./knowledge-validation";

/**
 * Состав FI/SI приложения. Все методы записи вызываются под транзакцией KnowledgeService;
 * заменой состава владеет ревизия приложения, отдельными записями — их собственные ревизии.
 */
export class KnowledgeParticipation {
  /* Внутренний механизм сохранения уже проверенного изменения. */
  private readonly entities: EntityService;
  /* Чтение того же соединения и снимка, что и запись. */
  private readonly queries: KnowledgeQueries;

  /**
   * Связывает операции с общими чтением и записью внешнего транзакционного сценария.
   */
  constructor(entities: EntityService, queries: KnowledgeQueries) {
    this.entities = entities;
    this.queries = queries;
  }

  /**
   * Загружает состав приложения один раз, включая снятые исторические реализации.
   */
  private implementations(applicationId: string): KnowledgeRecord<"implementation">[] {
    return this.queries
      .records("implementation")
      .filter((record) => record.data.applicationId === applicationId);
  }

  /**
   * Создаёт новое участие и обновляет состав приложения; прежнее снятое участие не дублируется.
   */
  create(
    applicationRef: string,
    targetRef: string,
    data: ImplementationContent,
    actor: string,
  ): KnowledgeRecord<"implementation"> {
    const application = this.queries.resolve(applicationRef, "application");
    const target = requireImplementationTarget(this.queries.resolve(targetRef));
    const existing = this.implementations(application.id);
    if (existing.some((record) => record.data.targetId === target.id)) {
      throw new RelayError("ALREADY_EXISTS", knowledgeMessages.participationExists, 4);
    }
    requireFeatureParticipation(target, existing);
    const created = this.insert(application, target, data, actor);
    this.save(
      application,
      [...existing.filter((record) => record.data.active).map((record) => record.id), created.id],
      actor,
    );
    return created;
  }

  /**
   * Разрешает цель состава либо реализацию данного приложения в её исходную цель.
   */
  private selectedTarget(ref: string, applicationId: string): ImplementationTarget {
    const record = this.queries.resolve(ref);
    if (record.kind === "implementation") {
      if (record.data.applicationId !== applicationId) {
        invalidKnowledge(knowledgeMessages.foreignImplementation);
      }
      return requireImplementationTarget(this.queries.resolve(record.data.targetId));
    }
    if (record.kind !== "feature" && record.kind !== "scenario") {
      invalidKnowledge(knowledgeMessages.participationTarget);
    }
    return record;
  }

  /**
   * Полностью проверяет выбор до записи, затем снимает или возвращает исторические реализации.
   * Вызывающий уже проверил CAS приложения, включая случай неизменного состава.
   */
  replace(
    application: KnowledgeRecord<"application">,
    refs: readonly string[],
    actor: string,
  ): KnowledgeRecord<"application"> {
    const existing = this.implementations(application.id);
    const selected = refs.map((ref) => this.selectedTarget(ref, application.id));
    requireParticipationSelection(selected);
    const byTarget = new Map<string, KnowledgeRecord<"implementation">>();
    for (const implementation of existing) {
      if (!byTarget.has(implementation.data.targetId)) {
        byTarget.set(implementation.data.targetId, implementation);
      }
    }
    const selectedIds = new Set(selected.map((record) => record.id));
    const active: string[] = [];
    for (const target of selected) {
      const implementation = byTarget.get(target.id);
      if (implementation !== undefined) {
        this.setActive(implementation, true, actor);
        active.push(implementation.id);
      } else {
        active.push(
          this.insert(
            application,
            target,
            { title: target.data.name, description: "", status: "none" },
            actor,
          ).id,
        );
      }
    }
    for (const implementation of existing) {
      if (!selectedIds.has(implementation.data.targetId)) {
        this.setActive(implementation, false, actor);
      }
    }
    return this.save(application, active, actor);
  }

  /**
   * Меняет только признак участия существующей реализации, сохраняя ID, ключ и содержание.
   * При прежнем значении не меняет её ревизию; блокировка и CAS приложения уже удерживаются.
   */
  private setActive(
    implementation: KnowledgeRecord<"implementation">,
    active: boolean,
    actor: string,
  ): void {
    if (implementation.data.active !== active) {
      this.entities.update(
        implementation.id,
        "implementation",
        { active },
        { actor, ifRevision: implementation.revision },
      );
    }
  }

  /**
   * Создаёт FI/SI с постоянными ссылками; разрешение цели уже выполнено в текущей транзакции.
   */
  private insert(
    application: KnowledgeRecord<"application">,
    target: ImplementationTarget,
    data: ImplementationContent,
    actor: string,
  ): KnowledgeRecord<"implementation"> {
    const featureId = target.kind === "feature" ? target.id : target.data.featureId;
    return decodeKnowledge(
      this.entities.create(
        "implementation",
        `${application.data.prefix}-${target.kind === "feature" ? "FI" : "SI"}`,
        {
          ...data,
          targetId: target.id,
          targetKind: target.kind,
          featureId,
          ...(target.kind === "scenario" ? { scenarioId: target.id } : {}),
          applicationId: application.id,
          active: true,
        },
        actor,
      ),
      "implementation",
    );
  }

  /**
   * Сохраняет канонический состав под прочитанной ревизией приложения; равный состав — no-op.
   */
  private save(
    application: KnowledgeRecord<"application">,
    ids: readonly string[],
    actor: string,
  ): KnowledgeRecord<"application"> {
    const ordered = [...ids].sort();
    if (sameKnowledgeCollection(ordered, application.data.implementationIds)) {
      return application;
    }
    return decodeKnowledge(
      this.entities.update(
        application.id,
        "application",
        { implementationIds: ordered },
        { actor, ifRevision: application.revision },
      ),
      "application",
    );
  }
}
