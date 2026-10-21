import {
  RelayError,
  validateActor,
  type PlanningKind,
  type PlanningRecord,
  type WorkPlanRecord,
  type ReleaseRecord,
  type WorkPlanData,
  type ReleaseData,
  type WorkPlanFields,
  type ReleaseFields,
  type PlanTransition,
  type ReleaseTransition,
  type PlanTransferResult,
  type WriteOptions,
} from "@relay/contracts";
import { PlanningQueries } from "./planning-queries";
import { decodePlan, decodeRelease, openPlan, stageIndex } from "./planning-data";
import {
  invalid,
  object,
  parsePlanFields,
  parseReleaseFields,
  parseStageChange,
  parsePlanTransition,
  parseReleaseTransition,
  parseTransfer,
  planningKind,
  reference,
  revision,
} from "./planning-input";
import { changeStages } from "./planning-stages";

export type { PlanningKind, PlanStage } from "@relay/contracts";

/** Записи планирования: проверка CAS, предметных правил и сохранение входят в одну транзакцию. */
export class PlanningService extends PlanningQueries {
  create(kind: "work-plan", input: unknown, actor: string): WorkPlanRecord;
  create(kind: "release", input: unknown, actor: string): ReleaseRecord;
  create(kind: PlanningKind, input: unknown, actor: string): PlanningRecord;
  create(kind: PlanningKind, input: unknown, actor: string): PlanningRecord {
    return this.db.transaction(() => {
      planningKind(kind);
      validateActor(actor);
      if (kind === "work-plan") {
        const fields = this.planFields(input);
        if (fields.title === undefined) invalid("Передайте заголовок плана.");
        const data: WorkPlanData = {
          projectId: this.db.projectId,
          summary: "",
          goal: "",
          rationale: "",
          boundaries: "",
          expectedResult: "",
          participants: [],
          scope: [],
          stages: [],
          result: "",
          status: "draft",
          startedAt: null,
          closedAt: null,
          ...fields,
          title: fields.title,
        };
        return decodePlan(this.entities.create(kind, "PLN", data, actor), this.db.projectId);
      }
      const fields = this.releaseFields(input);
      if (
        fields.title === undefined ||
        fields.version === undefined ||
        fields.planIds === undefined
      )
        invalid("Передайте title, version и planIds релиза.");
      const data: ReleaseData = {
        projectId: this.db.projectId,
        summary: "",
        description: "",
        plannedFor: "",
        status: "planned",
        releasedAt: null,
        releasedBy: null,
        ...fields,
        title: fields.title,
        version: fields.version,
        planIds: fields.planIds,
      };
      return decodeRelease(this.entities.create(kind, "REL", data, actor), this.db.projectId);
    });
  }

  /** ifRevision принадлежит изменяемому плану/релизу; проверяется до no-op. Закрытые записи неизменяемы. */
  update(kind: "work-plan", ref: string, input: unknown, options: WriteOptions): WorkPlanRecord;
  update(kind: "release", ref: string, input: unknown, options: WriteOptions): ReleaseRecord;
  update(kind: PlanningKind, ref: string, input: unknown, options: WriteOptions): PlanningRecord;
  update(kind: PlanningKind, ref: string, input: unknown, options: WriteOptions): PlanningRecord {
    return this.db.transaction(() => {
      const entity = this.get(kind, ref);
      this.writable(entity, options);
      if (entity.kind === "work-plan") {
        const fields = this.planFields(input);
        if (!Object.keys(fields).length) invalid("Передайте хотя бы одно поле изменения.");
        return this.savePlan(entity, fields, options);
      }
      const fields = this.releaseFields(input, new Set(entity.data.planIds));
      if (!Object.keys(fields).length) invalid("Передайте хотя бы одно поле изменения.");
      return this.saveRelease(entity, fields, options);
    });
  }

  /**
   * CAS защищает только план/релиз. Готовность всех связанных задач проверяется в той же
   * транзакции записи одним графом. Задачи и планы релиза не изменяются. NOT_READY не пишет;
   * повтор plan/cancel релиза — no-op после CAS, закрытый план и выпущенный релиз неизменяемы.
   */
  transition(
    kind: "work-plan",
    ref: string,
    action: string,
    input: unknown,
    options: WriteOptions,
  ): WorkPlanRecord;
  transition(
    kind: "release",
    ref: string,
    action: string,
    input: unknown,
    options: WriteOptions,
  ): ReleaseRecord;
  transition(
    kind: PlanningKind,
    ref: string,
    action: string,
    input: unknown,
    options: WriteOptions,
  ): PlanningRecord;
  transition(
    kind: PlanningKind,
    ref: string,
    action: string,
    input: unknown,
    options: WriteOptions,
  ): PlanningRecord {
    return this.db.transaction(() => {
      const entity = this.get(kind, ref);
      this.writable(entity, options);
      return entity.kind === "work-plan"
        ? this.transitionPlan(entity, parsePlanTransition(action, input), options)
        : this.transitionRelease(entity, parseReleaseTransition(action, input), options);
    });
  }

  /**
   * Изменяет этапы атомарно под ifRevision плана. CAS проверяется даже при перемещении
   * за край или перед самим собой; no-op не повышает ревизию. Непустой этап удалить нельзя.
   */
  stage(ref: string, action: string, input: unknown, options: WriteOptions): WorkPlanRecord {
    return this.db.transaction(() => {
      const plan = this.get("work-plan", ref);
      this.writable(plan, options);
      const stages = changeStages(plan.data.stages, parseStageChange(action, input));
      return this.savePlan(plan, { stages }, options);
    });
  }

  /**
   * Включение принадлежит плану: CAS и проверка единственного открытого включения атомарны.
   * Задача не изменяется; повтор включения/исключения — no-op после проверки ревизии плана.
   */
  stageTask(
    ref: string,
    stageId: string,
    task: string,
    remove: boolean,
    options: WriteOptions,
  ): WorkPlanRecord {
    return this.db.transaction(() => {
      const plan = this.get("work-plan", ref);
      this.writable(plan, options);
      if (typeof remove !== "boolean") invalid("remove должен быть логическим значением.");
      const stages = plan.data.stages;
      const stage = stages[stageIndex(stages, reference(stageId, "stageId"))]!;
      const taskId = this.tasks.get(reference(task, "task")).id;
      const included = stage.taskIds.includes(taskId);
      if (remove) {
        if (!included) return plan;
        stage.taskIds = stage.taskIds.filter((id) => id !== taskId);
      } else {
        this.assertAvailable(taskId, plan.id, stage.id);
        if (included) return plan;
        if (stage.taskIds.length >= 2000) invalid("В этапе допускается не более 2000 задач.");
        stage.taskIds.push(taskId);
      }
      return this.savePlan(plan, { stages }, options);
    });
  }

  /**
   * Атомарно переносит включение. ifRevision принадлежит исходному плану,
   * targetRevision — целевому; проверяются обе даже для одного плана и no-op.
   * При одном плане сохраняется одна ревизия, при двух — обе либо ни одна. Задача не пишется.
   */
  transfer(
    ref: string,
    input: unknown,
    options: WriteOptions & { targetRevision: number },
  ): PlanTransferResult {
    return this.db.transaction(() => {
      const fields = parseTransfer(input);
      object(options, ["actor", "ifRevision", "targetRevision"]);
      const source = this.get("work-plan", ref);
      const target = this.get("work-plan", fields.targetPlan);
      const sourceOptions = { actor: options.actor, ifRevision: options.ifRevision };
      const targetOptions = { actor: options.actor, ifRevision: revision(options.targetRevision) };
      this.writable(source, sourceOptions);
      this.writable(target, targetOptions);
      const taskId = this.tasks.get(fields.task).id;
      const sourceStages = source.data.stages;
      const targetStages = source.id === target.id ? sourceStages : target.data.stages;
      const sourceStage = sourceStages.find((stage) => stage.taskIds.includes(taskId));
      if (!sourceStage) throw new RelayError("NOT_FOUND", "Задача не включена в исходный план.", 3);
      const targetStage = targetStages[stageIndex(targetStages, fields.targetStage)]!;
      this.assertAvailable(taskId, source.id, sourceStage.id);
      if (source.id === target.id && sourceStage.id === targetStage.id) return { source, target };
      if (targetStage.taskIds.length >= 2000) invalid("В этапе допускается не более 2000 задач.");
      sourceStage.taskIds = sourceStage.taskIds.filter((id) => id !== taskId);
      targetStage.taskIds.push(taskId);
      const savedSource = this.savePlan(source, { stages: sourceStages }, sourceOptions);
      const savedTarget =
        source.id === target.id
          ? savedSource
          : this.savePlan(target, { stages: targetStages }, targetOptions);
      return { source: savedSource, target: savedTarget };
    });
  }

  private transitionPlan(
    plan: WorkPlanRecord,
    change: PlanTransition,
    options: WriteOptions,
  ): WorkPlanRecord {
    if (change.action === "start") {
      if (plan.data.status !== "draft")
        throw new RelayError("INVALID_TRANSITION", "Начать можно только черновик плана.", 4);
      if (!plan.data.goal.trim() || !plan.data.stages.some((stage) => stage.taskIds.length))
        throw new RelayError("NOT_READY", "Для начала плана нужны цель и хотя бы одна задача.", 4);
      return this.savePlan(
        plan,
        { status: "active", startedAt: new Date().toISOString() },
        options,
      );
    }
    if (change.action === "complete") {
      const progress = this.calculateProgress(plan);
      if (!progress.completed)
        throw new RelayError(
          "NOT_READY",
          "Для завершения плана нужны непустой состав и фактическое выполнение всех задач.",
          4,
          { progress },
        );
    }
    return this.savePlan(
      plan,
      {
        status: change.action === "complete" ? "completed" : "cancelled",
        result: change.result,
        closedAt: new Date().toISOString(),
      },
      options,
    );
  }

  private transitionRelease(
    release: ReleaseRecord,
    action: ReleaseTransition,
    options: WriteOptions,
  ): ReleaseRecord {
    if (action === "plan") {
      if (release.data.status === "planned") return release;
      this.resolvePlans(release.data.planIds);
      return this.saveRelease(release, { status: "planned" }, options);
    }
    if (action === "cancel") {
      if (release.data.status === "cancelled") return release;
      return this.saveRelease(release, { status: "cancelled" }, options);
    }
    if (release.data.status !== "planned")
      throw new RelayError(
        "INVALID_TRANSITION",
        "Отменённый релиз сначала нужно явно перепланировать.",
        4,
      );
    const progress = this.calculateProgress(release);
    if (!progress.completed)
      throw new RelayError(
        "NOT_READY",
        "Выпуск требует завершённых планов с актуально выполненными задачами.",
        4,
        { progress },
      );
    return this.saveRelease(
      release,
      { status: "released", releasedAt: new Date().toISOString(), releasedBy: options.actor },
      options,
    );
  }

  private writable(entity: PlanningRecord, options: WriteOptions): void {
    object(options, ["actor", "ifRevision"]);
    validateActor(options.actor);
    const expected = revision(options.ifRevision);
    if (entity.revision !== expected)
      throw new RelayError(
        "REVISION_CONFLICT",
        "Запись изменена; перечитайте её перед записью.",
        4,
        { id: entity.id, expectedRevision: expected, actualRevision: entity.revision },
      );
    if (entity.kind === "work-plan" && !openPlan(entity))
      throw new RelayError("PLAN_READ_ONLY", "Закрытый план доступен только для чтения.", 4);
    if (entity.kind === "release" && entity.data.status === "released")
      throw new RelayError("RELEASE_READ_ONLY", "Выпущенный релиз неизменяем.", 4);
  }

  private planFields(input: unknown): Partial<WorkPlanFields> {
    const fields = parsePlanFields(input);
    if (fields.scope) {
      fields.scope = fields.scope.map((entry) => ({
        kind: entry.kind,
        id: this.entities.get(entry.id, entry.kind).id,
      }));
      if (new Set(fields.scope.map((entry) => entry.id)).size !== fields.scope.length)
        invalid("Области воздействия не должны повторяться.");
    }
    return fields;
  }

  private releaseFields(input: unknown, previous = new Set<string>()): Partial<ReleaseFields> {
    const fields = parseReleaseFields(input);
    if (fields.planIds) fields.planIds = this.resolvePlans(fields.planIds, previous);
    return fields;
  }

  private resolvePlans(refs: readonly string[], previous = new Set<string>()): string[] {
    const ids = refs.map((ref) => {
      const plan = this.get("work-plan", ref);
      if (plan.data.status === "cancelled" && !previous.has(plan.id))
        throw new RelayError("INVALID_PLAN", "Нельзя включить отменённый план в релиз.", 4, {
          id: plan.id,
        });
      return plan.id;
    });
    if (new Set(ids).size !== ids.length)
      invalid("Планы в составе релиза не должны повторяться, включая ссылки по ключу и ID.");
    return ids;
  }

  private assertAvailable(taskId: string, planId: string, stageId: string): void {
    // Исторический состав закрытого плана не препятствует новому текущему включению.
    for (const plan of this.list("work-plan")) {
      if (!openPlan(plan)) continue;
      for (const stage of plan.data.stages) {
        if (stage.taskIds.includes(taskId) && (plan.id !== planId || stage.id !== stageId))
          throw new RelayError(
            "MEMBERSHIP_CONFLICT",
            "Задача уже включена в другой открытый план или этап; используйте явный перенос.",
            4,
            { taskId, planId: plan.id, stageId: stage.id },
          );
      }
    }
  }

  private savePlan(
    plan: WorkPlanRecord,
    fields: Partial<WorkPlanData>,
    options: WriteOptions,
  ): WorkPlanRecord {
    return decodePlan(
      this.entities.update(plan.id, "work-plan", fields, options),
      this.db.projectId,
    );
  }

  private saveRelease(
    release: ReleaseRecord,
    fields: Partial<ReleaseData>,
    options: WriteOptions,
  ): ReleaseRecord {
    return decodeRelease(
      this.entities.update(release.id, "release", fields, options),
      this.db.projectId,
    );
  }
}
