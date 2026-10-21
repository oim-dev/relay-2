import {
  RelayError,
  validateActor,
  type PlanningKind,
  type PlanningRecord,
  type WorkPlanRecord,
  type ReleaseRecord,
  type WorkPlanData,
  type ReleaseData,
  type PlanTransition,
  type ReleaseTransition,
  type PlanTransferResult,
  type WriteOptions,
} from "@relay/contracts";
import { PlanningQueries } from "./planning-queries";
import { decodePlan, decodeRelease } from "./planning-data";
import {
  parseStageChange,
  parsePlanTransition,
  parseReleaseTransition,
  parseTransfer,
  planningKind,
} from "./planning-input";
import { invalid, object, reference, revision } from "./planning-validation";
import { changeStages, changeStageTask, transferStageTask } from "./planning-stages";
import {
  newPlanData,
  newReleaseData,
  preparePlanFields,
  prepareReleaseFields,
  resolveReleasePlans,
} from "./planning-preparation";
import {
  assertPlanCanStart,
  assertPlanningWritable,
  assertTaskAvailable,
  requireStage,
} from "./planning-rules";
import { planningMessages } from "./planning.messages";
import type { PlanTransferWriteOptions } from "./planning.types";

export type { PlanningKind, PlanStage } from "@relay/contracts";

/**
 * Записи планирования: проверка CAS, предметных правил и сохранение входят в одну транзакцию.
 * Сервис связывает подготовку содержания, чистые правила и запись; задачи состава не изменяет.
 */
export class PlanningService extends PlanningQueries {
  /**
   * Создаёт черновик плана с новым ID и ключом в одной транзакции.
   * input соответствует WorkPlanInput: title обязателен; состояние и этапы задаёт Core.
   * Ссылки scope разрешаются в ID до записи, отсутствующие тексты и списки становятся пустыми.
   */
  create(kind: "work-plan", input: unknown, actor: string): WorkPlanRecord;
  /**
   * Создаёт запланированный релиз с проверенным непустым составом планов.
   * input соответствует ReleaseInput: title, version и planIds обязательны; состав допускает ссылки.
   * Отменённый план даёт INVALID_PLAN без записи релиза и расходования ключа.
   */
  create(kind: "release", input: unknown, actor: string): ReleaseRecord;
  /**
   * Создаёт запись выбранного вида; каждому вызову соответствует новая запись.
   */
  create(kind: PlanningKind, input: unknown, actor: string): PlanningRecord;
  /**
   * Проверяет ввод, разрешает ссылки и создаёт запись атомарно в текущем проекте.
   * Отказ подготовки не выделяет ключ и не меняет связанные записи.
   */
  create(kind: PlanningKind, input: unknown, actor: string): PlanningRecord {
    return this.db.transaction(() => {
      planningKind(kind);
      validateActor(actor);
      if (kind === "work-plan") {
        const fields = preparePlanFields(this.entities, input);
        const data = newPlanData(fields, this.db.projectId);
        return decodePlan(this.entities.create(kind, "PLN", { ...data }, actor), this.db.projectId);
      }
      const fields = prepareReleaseFields(this.entities, this.db.projectId, input);
      const data = newReleaseData(fields, this.db.projectId);
      return decodeRelease(
        this.entities.create(kind, "REL", { ...data }, actor),
        this.db.projectId,
      );
    });
  }

  /**
   * Атомарно меняет содержание открытого плана под его ifRevision.
   * Ревизия проверяется до no-op; неизменные поля сохраняют ревизию, пустой набор запрещён.
   */
  update(
    kind: "work-plan",
    ref: string,
    input: unknown,
    options: Readonly<WriteOptions>,
  ): WorkPlanRecord;
  /**
   * Атомарно меняет содержание невыпущенного релиза под его ifRevision.
   * Ревизия проверяется до no-op; неизменные поля сохраняют ревизию, планы состава не пишутся.
   * Прежние отменённые планы можно оставить в составе; новое включение такого плана даёт INVALID_PLAN.
   */
  update(
    kind: "release",
    ref: string,
    input: unknown,
    options: Readonly<WriteOptions>,
  ): ReleaseRecord;
  /**
   * Меняет содержание выбранной записи; пустой набор полей запрещён.
   * Проверка ревизии владельца и запись атомарны; неизменные поля не повышают ревизию.
   */
  update(
    kind: PlanningKind,
    ref: string,
    input: unknown,
    options: Readonly<WriteOptions>,
  ): PlanningRecord;
  /**
   * Проверяет ревизию владельца до подготовки и no-op в общей транзакции записи.
   * Закрытый план и выпущенный релиз неизменяемы; те же поля сохраняют ревизию.
   */
  update(
    kind: PlanningKind,
    ref: string,
    input: unknown,
    options: Readonly<WriteOptions>,
  ): PlanningRecord {
    return this.db.transaction(() => {
      const entity = this.get(kind, ref);
      assertPlanningWritable(entity, options);
      if (entity.kind === "work-plan") {
        const fields = preparePlanFields(this.entities, input);
        if (!Object.keys(fields).length) {
          invalid(planningMessages.emptyUpdate);
        }
        return this.savePlan(entity, fields, options);
      }
      const fields = prepareReleaseFields(
        this.entities,
        this.db.projectId,
        input,
        new Set(entity.data.planIds),
      );
      if (!Object.keys(fields).length) {
        invalid(planningMessages.emptyUpdate);
      }
      return this.saveRelease(entity, fields, options);
    });
  }

  /**
   * Атомарно выполняет начало, завершение или отмену плана под ревизией самого плана.
   * Закрытый план неизменяем; завершение требует непустого фактически выполненного состава.
   */
  transition(
    kind: "work-plan",
    ref: string,
    action: string,
    input: unknown,
    options: Readonly<WriteOptions>,
  ): WorkPlanRecord;
  /**
   * Атомарно планирует, отменяет или публикует релиз под ревизией самого релиза.
   * Повтор plan/cancel — no-op после CAS; публикация требует актуально выполненных completed-планов.
   */
  transition(
    kind: "release",
    ref: string,
    action: string,
    input: unknown,
    options: Readonly<WriteOptions>,
  ): ReleaseRecord;
  /**
   * Выполняет переход выбранного вида без изменения связанных задач и планов состава.
   * CAS и проверка готовности одним графом входят в ту же транзакцию, что и запись.
   */
  transition(
    kind: PlanningKind,
    ref: string,
    action: string,
    input: unknown,
    options: Readonly<WriteOptions>,
  ): PlanningRecord;
  /**
   * Проверяет CAS владельца и готовность всех связанных задач в одной транзакции и одном графе.
   * NOT_READY не пишет; повтор plan/cancel релиза — no-op после CAS.
   * Закрытый план и выпущенный релиз не допускают даже повторного перехода.
   */
  transition(
    kind: PlanningKind,
    ref: string,
    action: string,
    input: unknown,
    options: Readonly<WriteOptions>,
  ): PlanningRecord {
    return this.db.transaction(() => {
      const entity = this.get(kind, ref);
      assertPlanningWritable(entity, options);
      return entity.kind === "work-plan"
        ? this.transitionPlan(entity, parsePlanTransition(action, input), options)
        : this.transitionRelease(entity, parseReleaseTransition(action, input), options);
    });
  }

  /**
   * Изменяет этапы атомарно под ifRevision плана. CAS проверяется даже при перемещении
   * за край или перед самим собой; no-op не повышает ревизию. Непустой этап удалить нельзя.
   * create принимает title, необязательные тексты StageFields и before (null либо отсутствие — конец).
   * update принимает stageId и непустой набор StageFields; remove — только stageId.
   * move принимает stageId и ровно одно из before (ID либо null) или direction (up/down).
   */
  stage(
    ref: string,
    action: string,
    input: unknown,
    options: Readonly<WriteOptions>,
  ): WorkPlanRecord {
    return this.db.transaction(() => {
      const plan = this.get("work-plan", ref);
      assertPlanningWritable(plan, options);
      const stages = changeStages(plan.data.stages, parseStageChange(action, input));
      return this.savePlan(plan, { stages }, options);
    });
  }

  /**
   * Включение принадлежит плану: CAS и проверка единственного открытого включения атомарны.
   * Задача не изменяется; повтор включения/исключения — no-op после проверки ревизии плана.
   * Новое и повторное включение читают все планы проекта для проверки конфликта состава.
   */
  stageTask(
    ref: string,
    stageId: string,
    task: string,
    remove: boolean,
    options: Readonly<WriteOptions>,
  ): WorkPlanRecord {
    return this.db.transaction(() => {
      const plan = this.get("work-plan", ref);
      assertPlanningWritable(plan, options);
      if (typeof remove !== "boolean") {
        invalid(planningMessages.invalidRemove);
      }
      const stage = requireStage(plan.data.stages, reference(stageId, "stageId"));
      const taskId = this.tasks.get(reference(task, "task")).id;
      if (!remove) {
        assertTaskAvailable(this.list("work-plan"), taskId, { planId: plan.id, stageId: stage.id });
      }
      const stages = changeStageTask(
        plan.data.stages,
        stage,
        taskId,
        remove ? "remove" : "include",
      );
      if (stages === undefined) {
        return plan;
      }
      return this.savePlan(plan, { stages }, options);
    });
  }

  /**
   * Атомарно переносит включение. ifRevision принадлежит исходному плану,
   * targetRevision — целевому; проверяются обе даже для одного плана и no-op.
   * При одном плане сохраняется одна ревизия, при двух — обе либо ни одна. Задача не пишется.
   * Обязательное обоснование проверяется, но перенос не дописывает комментарий задачи.
   * input соответствует PlanTaskTransfer; проверка конфликтов читает все планы проекта.
   */
  transfer(ref: string, input: unknown, options: PlanTransferWriteOptions): PlanTransferResult {
    return this.db.transaction(() => {
      const fields = parseTransfer(input);
      object(options, ["actor", "ifRevision", "targetRevision"]);
      const source = this.get("work-plan", ref);
      const target = this.get("work-plan", fields.targetPlan);
      const sourceOptions = { actor: options.actor, ifRevision: options.ifRevision };
      const targetOptions = { actor: options.actor, ifRevision: revision(options.targetRevision) };
      assertPlanningWritable(source, sourceOptions);
      assertPlanningWritable(target, targetOptions);
      const taskId = this.tasks.get(fields.task).id;
      const sourceStage = source.data.stages.find((stage) => stage.taskIds.includes(taskId));
      if (sourceStage === undefined) {
        throw new RelayError("NOT_FOUND", planningMessages.sourceTaskNotFound, 3);
      }
      const targetStage = requireStage(
        source.id === target.id ? source.data.stages : target.data.stages,
        fields.targetStage,
      );
      assertTaskAvailable(this.list("work-plan"), taskId, {
        planId: source.id,
        stageId: sourceStage.id,
      });
      const stages = transferStageTask(source, target, sourceStage, targetStage, taskId);
      if (stages === undefined) {
        return { source, target };
      }
      const savedSource = this.savePlan(source, { stages: stages.source }, sourceOptions);
      const savedTarget =
        source.id === target.id
          ? savedSource
          : this.savePlan(target, { stages: stages.target }, targetOptions);
      return { source: savedSource, target: savedTarget };
    });
  }

  /**
   * Выполняет переход уже проверенного открытого плана внутри транзакции вызывающего метода.
   * Завершение требует фактического выполнения; отмена сохраняет состав без расчёта графа.
   */
  private transitionPlan(
    plan: Readonly<WorkPlanRecord>,
    change: Readonly<PlanTransition>,
    options: Readonly<WriteOptions>,
  ): WorkPlanRecord {
    if (change.action === "start") {
      assertPlanCanStart(plan);
      return this.savePlan(
        plan,
        { status: "active", startedAt: new Date().toISOString() },
        options,
      );
    }
    if (change.action === "complete") {
      const progress = this.calculateProgress(plan);
      if (!progress.completed) {
        throw new RelayError("NOT_READY", planningMessages.planNotReady, 4, { progress });
      }
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

  /**
   * Выполняет переход невыпущенного релиза после CAS внутри текущей транзакции.
   * Повтор plan/cancel сохраняет ревизию; перепланирование заново проверяет весь состав.
   * Выпуск читает один граф актуальной готовности и записывает автора только в релиз.
   */
  private transitionRelease(
    release: Readonly<ReleaseRecord>,
    action: ReleaseTransition,
    options: Readonly<WriteOptions>,
  ): ReleaseRecord {
    if (action === "plan") {
      if (release.data.status === "planned") {
        return release;
      }
      resolveReleasePlans(this.entities, this.db.projectId, release.data.planIds);
      return this.saveRelease(release, { status: "planned" }, options);
    }
    if (action === "cancel") {
      if (release.data.status === "cancelled") {
        return release;
      }
      return this.saveRelease(release, { status: "cancelled" }, options);
    }
    if (release.data.status !== "planned") {
      throw new RelayError("INVALID_TRANSITION", planningMessages.releaseRequiresReplanning, 4);
    }
    const progress = this.calculateProgress(release);
    if (!progress.completed) {
      throw new RelayError("NOT_READY", planningMessages.releaseNotReady, 4, { progress });
    }
    return this.saveRelease(
      release,
      { status: "released", releasedAt: new Date().toISOString(), releasedBy: options.actor },
      options,
    );
  }

  /**
   * Сохраняет подготовленные поля плана под его ревизией и декодирует результат.
   * Вызывается после предметных проверок внутри внешней транзакции; EntityService сохраняет no-op.
   */
  private savePlan(
    plan: Readonly<WorkPlanRecord>,
    fields: Readonly<Partial<WorkPlanData>>,
    options: Readonly<WriteOptions>,
  ): WorkPlanRecord {
    return decodePlan(
      this.entities.update(plan.id, "work-plan", { ...fields }, options),
      this.db.projectId,
    );
  }

  /**
   * Сохраняет подготовленные поля релиза под его ревизией без записи планов состава.
   * Внешняя транзакция охватывает проверки и запись; неизменное содержание не повышает ревизию.
   */
  private saveRelease(
    release: Readonly<ReleaseRecord>,
    fields: Readonly<Partial<ReleaseData>>,
    options: Readonly<WriteOptions>,
  ): ReleaseRecord {
    return decodeRelease(
      this.entities.update(release.id, "release", { ...fields }, options),
      this.db.projectId,
    );
  }
}
