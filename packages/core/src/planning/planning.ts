import {
  RelayError,
  type CommandExecutionContext,
  type PlanningKind,
  type PlanningRecord,
  type WorkPlanRecord,
  type ReleaseRecord,
  type PlanTransferResult,
  type CommandWriteOptions,
} from "@relay/contracts";
import type { ProjectStore } from "@relay/storage";
import { executeCommand, executeEntityCommand } from "../commands/command-facade";
import { PlanningQueries } from "./planning-queries";
import { decodePlan, decodePlanning } from "./planning-data";
import {
  parsePlanCommandInput,
  parseReleaseFields,
  parseStageChange,
  parsePlanTransition,
  parseReleaseTransition,
  parseTransfer,
  planningKind,
} from "./planning-input";
import { invalid, object, reference } from "./planning-validation";
import {
  parsePlanningWriteOptions,
  parsePlanningTransferWriteOptions,
} from "./planning-write-options";
import { planningMessages } from "./planning.messages";
import type { PlanTransferWriteOptions } from "./planning.types";

export type { PlanningKind, PlanStage } from "@relay/contracts";

/**
 * Синхронные оптимизированные чтения и тонкий async фасад общего command executor.
 * Все записи используют явные загрузки, чистый расчёт и один guarded atomic commit.
 */
export class PlanningService extends PlanningQueries {
  /* Клиентские ожидания адресов; не заменяют CAS владельцев. */
  private readonly execution: CommandExecutionContext;

  /**
   * Подключает чтения и команды к проекту; соединение остаётся у вызывающего приложения.
   */
  constructor(db: ProjectStore, execution: CommandExecutionContext = {}) {
    super(db);
    this.execution = execution;
  }

  /**
   * Создаёт черновик с новым ID/ключом; scope допускает объекты и исходные строковые ссылки CLI.
   */
  create(kind: "work-plan", input: unknown, actor: string): Promise<WorkPlanRecord>;
  /**
   * Создаёт planned релиз с непустым составом; отменённый план отклоняется без записи.
   */
  create(kind: "release", input: unknown, actor: string): Promise<ReleaseRecord>;
  /**
   * Создаёт запись выбранного вида одним atomic commit.
   */
  create(kind: PlanningKind, input: unknown, actor: string): Promise<PlanningRecord>;
  /**
   * Проверяет внешнюю форму до упаковки команды, затем использует единый async исполнитель.
   */
  async create(kind: PlanningKind, input: unknown, actor: string): Promise<PlanningRecord> {
    planningKind(kind);
    const fields =
      kind === "work-plan" ? parsePlanCommandInput(input) : { ...parseReleaseFields(input) };
    const record = await executeEntityCommand(
      this.db,
      { op: kind === "work-plan" ? "plan.create" : "release.create", input: fields },
      actor,
      this.execution,
    );
    return decodePlanning(record, this.db.projectId);
  }

  /**
   * Меняет содержание открытого плана под исходным CAS либо token агрегата до no-op.
   */
  update(
    kind: "work-plan",
    ref: string,
    input: unknown,
    options: Readonly<CommandWriteOptions>,
  ): Promise<WorkPlanRecord>;
  /**
   * Меняет невыпущенный релиз; прежний отменённый план разрешено сохранить в составе.
   */
  update(
    kind: "release",
    ref: string,
    input: unknown,
    options: Readonly<CommandWriteOptions>,
  ): Promise<ReleaseRecord>;
  /**
   * Меняет выбранного владельца без обновления ревизий связанных задач или планов.
   */
  update(
    kind: PlanningKind,
    ref: string,
    input: unknown,
    options: Readonly<CommandWriteOptions>,
  ): Promise<PlanningRecord>;
  /**
   * Передаёт исходные условия общему исполнителю; явный token метода заменяет constructor
   * default, но не отменяет дополнительно переданный CAS. Неизменный текст сохраняет ревизию.
   */
  async update(
    kind: PlanningKind,
    ref: string,
    input: unknown,
    options: Readonly<CommandWriteOptions>,
  ): Promise<PlanningRecord> {
    planningKind(kind);
    const { actor, ...conditions } = parsePlanningWriteOptions(
      options,
      this.execution.expectedVersion,
    );
    const fields =
      kind === "work-plan" ? parsePlanCommandInput(input) : { ...parseReleaseFields(input) };
    return decodePlanning(
      await executeEntityCommand(
        this.db,
        {
          op: kind === "work-plan" ? "plan.update" : "release.update",
          ref,
          input: fields,
          ...conditions,
        },
        actor,
        this.execution,
      ),
      this.db.projectId,
    );
  }

  /**
   * Начинает, завершает или отменяет план; закрытый план неизменяем даже при повторе.
   */
  transition(
    kind: "work-plan",
    ref: string,
    action: string,
    input: unknown,
    options: Readonly<CommandWriteOptions>,
  ): Promise<WorkPlanRecord>;
  /**
   * Планирует, публикует либо отменяет релиз; повтор plan/cancel — no-op после CAS.
   */
  transition(
    kind: "release",
    ref: string,
    action: string,
    input: unknown,
    options: Readonly<CommandWriteOptions>,
  ): Promise<ReleaseRecord>;
  /**
   * Выполняет предметный переход выбранного вида атомарно с проверкой оснований.
   */
  transition(
    kind: PlanningKind,
    ref: string,
    action: string,
    input: unknown,
    options: Readonly<CommandWriteOptions>,
  ): Promise<PlanningRecord>;
  /**
   * Передаёт переход executor; готовность считается по одному согласованному графу вне write lock.
   */
  async transition(
    kind: PlanningKind,
    ref: string,
    action: string,
    input: unknown,
    options: Readonly<CommandWriteOptions>,
  ): Promise<PlanningRecord> {
    planningKind(kind);
    const { actor, ...conditions } = parsePlanningWriteOptions(
      options,
      this.execution.expectedVersion,
    );
    const change =
      kind === "work-plan"
        ? parsePlanTransition(action, input)
        : parseReleaseTransition(action, input);
    const fields =
      typeof change !== "string" && "result" in change ? { result: change.result } : {};
    return decodePlanning(
      await executeEntityCommand(
        this.db,
        {
          op: `${kind === "work-plan" ? "plan" : "release"}.${action}`,
          ref,
          input: fields,
          ...conditions,
        },
        actor,
        this.execution,
      ),
      this.db.projectId,
    );
  }

  /**
   * Меняет этапы под CAS либо token плана. Непустой этап удалить нельзя; движение за край — no-op.
   */
  async stage(
    ref: string,
    action: string,
    input: unknown,
    options: Readonly<CommandWriteOptions>,
  ): Promise<WorkPlanRecord> {
    const { actor, ...conditions } = parsePlanningWriteOptions(
      options,
      this.execution.expectedVersion,
    );
    parseStageChange(action, input);
    const fields = object(
      input,
      action === "create"
        ? ["title", "summary", "outcome", "completionConditions", "before"]
        : ["stageId", "title", "summary", "outcome", "completionConditions", "before", "direction"],
    );
    return decodePlan(
      await executeEntityCommand(
        this.db,
        { op: `plan.stage.${action}`, ref, input: fields, ...conditions },
        actor,
        this.execution,
      ),
      this.db.projectId,
    );
  }

  /**
   * Изменяет включение под CAS либо token плана. Все включения только выбранной задачи защищены
   * именованной выборкой, включая пустоту; задача не меняется, повтор — no-op после CAS.
   */
  async stageTask(
    ref: string,
    stageId: string,
    task: string,
    remove: boolean,
    options: Readonly<CommandWriteOptions>,
  ): Promise<WorkPlanRecord> {
    const { actor, ...conditions } = parsePlanningWriteOptions(
      options,
      this.execution.expectedVersion,
    );
    if (typeof remove !== "boolean") {
      invalid(planningMessages.invalidRemove);
    }
    return decodePlan(
      await executeEntityCommand(
        this.db,
        {
          op: `plan.stage.task.${remove ? "remove" : "add"}`,
          ref,
          ...conditions,
          input: { stageId: reference(stageId, "stageId"), task: reference(task, "task") },
        },
        actor,
        this.execution,
      ),
      this.db.projectId,
    );
  }

  /**
   * Атомарно переносит включение, проверяя CAS/token каждой стороны даже при одном владельце.
   * Один план получает одну новую ревизию; причина обязательна, журнал задачи не дописывается.
   */
  async transfer(
    ref: string,
    input: unknown,
    options: PlanTransferWriteOptions,
  ): Promise<PlanTransferResult> {
    const fields = parseTransfer(input);
    const { actor, targetRevision, targetVersion, ...conditions } =
      parsePlanningTransferWriteOptions(options, this.execution.expectedVersion);
    const result = await executeCommand(
      this.db,
      {
        op: "plan.stage.task.transfer",
        ref,
        ...conditions,
        input: {
          ...fields,
          ...(targetRevision === undefined ? {} : { targetRevision }),
          ...(targetVersion === undefined ? {} : { targetVersion }),
        },
      },
      actor,
      this.execution,
    );
    const item = result.items[0];
    const targetId = item?.outputs.find((output) => output.name === "target")?.id;
    const source = result.entities.find((record) => record.id === item?.id);
    const target = result.entities.find((record) => record.id === targetId);
    if (source === undefined || target === undefined) {
      throw new RelayError("CORRUPT_DATA", planningMessages.missingResult);
    }
    return {
      source: decodePlan(source, this.db.projectId),
      target: decodePlan(target, this.db.projectId),
    };
  }
}
