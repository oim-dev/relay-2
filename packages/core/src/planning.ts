import {
  RelayError,
  type EntityKind,
  type EntityRecord,
  type WriteOptions,
} from "@relay/contracts";
import type { ProjectDatabase } from "@relay/storage";
import { EntityService } from "./entities";
import { TasksService } from "./tasks";

export type PlanningKind = "work-plan" | "release";

export interface PlanStage {
  id: string;
  title: string;
  summary: string;
  outcome: string;
  completionConditions: string;
  taskIds: string[];
}

interface Counts {
  total: number;
  completed: number;
  percent: number;
}

interface PlanProgress extends Record<string, unknown> {
  completed: boolean;
  canComplete: boolean;
  blockers: string[];
  counts: Counts;
  stages: Array<{ id: string; completed: boolean; counts: Counts; blockers: string[] }>;
}

interface ReleaseProgress extends Record<string, unknown> {
  completed: boolean;
  canRelease: boolean;
  blockers: string[];
  counts: Counts;
  plans: Array<{ id: string; status: string; completed: boolean; blockers: string[] }>;
}

const planFields = [
  "title",
  "summary",
  "goal",
  "rationale",
  "boundaries",
  "expectedResult",
  "participants",
  "scope",
];
const releaseFields = ["title", "version", "summary", "description", "planIds", "plannedFor"];
const stageFields = ["title", "summary", "outcome", "completionConditions"];
const scopeKinds = new Set<EntityKind>([
  "project",
  "product",
  "application",
  "feature",
  "scenario",
  "implementation",
]);

function invalid(message: string): never {
  throw new RelayError("VALIDATION_ERROR", message, 2);
}

function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid("Ожидается объект полей.");
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    invalid("Ожидается обычный объект полей.");
  }
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result)) {
    if (!allowed.includes(key)) invalid(`Неизвестное поле: ${key}.`);
    if (result[key] === undefined) invalid(`Поле ${key} не может быть undefined.`);
  }
  return result;
}

function text(
  value: unknown,
  field: string,
  max = 256 * 1024,
  required = false,
  line = false,
): string {
  if (typeof value !== "string" || value.length > max || value.includes("\0")) {
    invalid(`Поле ${field} должно быть строкой длиной не более ${max} без NUL.`);
  }
  if (required && !value.trim()) invalid(`Поле ${field} не должно быть пустым.`);
  if (line && /[\r\n\u2028\u2029]/u.test(value))
    invalid(`Поле ${field} должно занимать одну строку.`);
  // Markdown сохраняется дословно: trim нужен только для проверки непустого содержания.
  return value;
}

function reference(value: unknown, field: string): string {
  return text(value, field, 256, true, true);
}

function author(value: unknown): string {
  const actor = text(value, "actor", 160, true, true);
  if (actor !== actor.trim() || /\p{Cc}/u.test(actor)) invalid("Некорректный автор действия.");
  return actor;
}

function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    invalid("Ожидаемая ревизия должна быть положительным целым числом.");
  }
  return value;
}

function counts(total: number, completed: number): Counts {
  return { total, completed, percent: total ? Math.floor((completed * 100) / total) : 0 };
}

function openPlan(entity: EntityRecord): boolean {
  return entity.data.status === "draft" || entity.data.status === "active";
}

export class PlanningService {
  private readonly entities: EntityService;
  private readonly tasks: TasksService;

  constructor(private readonly db: ProjectDatabase) {
    this.entities = new EntityService(db);
    this.tasks = new TasksService(db);
  }

  list(kind: PlanningKind): EntityRecord[] {
    this.kind(kind);
    return this.entities.list(kind);
  }

  get(kind: PlanningKind, ref: string): EntityRecord {
    this.kind(kind);
    return this.entities.get(reference(ref, "ref"), kind);
  }

  create(kind: PlanningKind, input: Record<string, unknown>, actor: string): EntityRecord {
    return this.db.transaction(() => {
      this.kind(kind);
      author(actor);
      const fields = this.fields(kind, input, true);
      const defaults =
        kind === "work-plan"
          ? {
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
            }
          : {
              summary: "",
              description: "",
              plannedFor: "",
              status: "planned",
              releasedAt: null,
              releasedBy: null,
            };
      return this.entities.create(
        kind,
        kind === "work-plan" ? "PLN" : "REL",
        { projectId: this.db.projectId, ...defaults, ...fields },
        actor,
      );
    });
  }

  update(
    kind: PlanningKind,
    ref: string,
    input: Record<string, unknown>,
    options: WriteOptions,
  ): EntityRecord {
    return this.db.transaction(() => {
      const entity = this.get(kind, ref);
      this.writable(entity, options);
      const fields = this.fields(kind, input, false, entity);
      if (!Object.keys(fields).length) invalid("Передайте хотя бы одно поле изменения.");
      return this.entities.update(entity.id, kind, fields, options);
    });
  }

  transition(
    kind: PlanningKind,
    ref: string,
    action: string,
    input: Record<string, unknown>,
    options: WriteOptions,
  ): EntityRecord {
    return this.db.transaction(() => {
      const entity = this.get(kind, ref);
      this.writable(entity, options);
      if (kind === "work-plan") {
        if (!["start", "complete", "cancel"].includes(action))
          invalid(`Неизвестное действие плана: ${action}.`);
        object(input, action === "start" ? [] : ["result"]);
        if (action === "start") {
          if (entity.data.status !== "draft") {
            throw new RelayError("INVALID_TRANSITION", "Начать можно только черновик плана.", 4);
          }
          if (
            !text(entity.data.goal, "goal").trim() ||
            !this.stages(entity).some((stage) => stage.taskIds.length)
          ) {
            throw new RelayError(
              "NOT_READY",
              "Для начала плана нужны цель и хотя бы одна задача.",
              4,
            );
          }
          return this.entities.update(
            entity.id,
            kind,
            { status: "active", startedAt: new Date().toISOString() },
            options,
          );
        }
        const result = text(input.result, "result", 256 * 1024, true);
        if (action === "complete") {
          const progress = this.planProgress(entity);
          if (!progress.completed) {
            throw new RelayError(
              "NOT_READY",
              "Для завершения плана нужны непустой состав и фактическое выполнение всех задач.",
              4,
              { progress },
            );
          }
        }
        return this.entities.update(
          entity.id,
          kind,
          {
            status: action === "complete" ? "completed" : "cancelled",
            result,
            closedAt: new Date().toISOString(),
          },
          options,
        );
      }

      if (!["plan", "cancel", "publish"].includes(action))
        invalid(`Неизвестное действие релиза: ${action}.`);
      object(input, []);
      if (action === "plan") {
        if (entity.data.status === "planned") return entity;
        this.resolvePlans(entity.data.planIds);
        return this.entities.update(entity.id, kind, { status: "planned" }, options);
      }
      if (action === "cancel") {
        if (entity.data.status === "cancelled") return entity;
        return this.entities.update(entity.id, kind, { status: "cancelled" }, options);
      }
      if (entity.data.status !== "planned") {
        throw new RelayError(
          "INVALID_TRANSITION",
          "Отменённый релиз сначала нужно явно перепланировать.",
          4,
        );
      }
      const progress = this.releaseProgress(entity);
      if (!progress.completed) {
        throw new RelayError(
          "NOT_READY",
          "Выпуск требует завершённых планов с актуально выполненными задачами.",
          4,
          { progress },
        );
      }
      return this.entities.update(
        entity.id,
        kind,
        {
          status: "released",
          releasedAt: new Date().toISOString(),
          releasedBy: options.actor,
        },
        options,
      );
    });
  }

  stage(
    ref: string,
    action: string,
    input: Record<string, unknown>,
    options: WriteOptions,
  ): EntityRecord {
    return this.db.transaction(() => {
      const plan = this.get("work-plan", ref);
      this.writable(plan, options);
      const stages = this.stages(plan);
      if (action === "create") {
        object(input, [...stageFields, "before"]);
        if (stages.length >= 200) invalid("В плане допускается не более 200 этапов.");
        const fields = this.stageFields(input, true);
        const stage: PlanStage = {
          id: crypto.randomUUID(),
          title: fields.title as string,
          summary: "",
          outcome: "",
          completionConditions: "",
          ...fields,
          taskIds: [],
        };
        const before = this.beforeIndex(stages, input.before ?? null);
        stages.splice(before, 0, stage);
      } else {
        if (!["update", "remove", "move"].includes(action))
          invalid(`Неизвестное действие этапа: ${action}.`);
        object(
          input,
          action === "update"
            ? ["stageId", ...stageFields]
            : action === "move"
              ? ["stageId", "before", "direction"]
              : ["stageId"],
        );
        const stageId = reference(input.stageId, "stageId");
        const index = this.stageIndex(stages, stageId);
        const stage = stages[index]!;
        if (action === "update") {
          const fields = this.stageFields(input, false);
          if (!Object.keys(fields).length) invalid("Передайте хотя бы одно поле этапа.");
          stages[index] = { ...stage, ...fields };
        } else if (action === "remove") {
          if (stage.taskIds.length)
            throw new RelayError("STAGE_NOT_EMPTY", "Удалить можно только пустой этап.", 4);
          stages.splice(index, 1);
        } else {
          const hasBefore = Object.hasOwn(input, "before");
          const hasDirection = Object.hasOwn(input, "direction");
          if (hasBefore === hasDirection)
            invalid("Для перемещения передайте ровно одно поле: before или direction.");
          if (hasDirection) {
            if (input.direction !== "up" && input.direction !== "down")
              invalid("direction должен быть up или down.");
            const destination = index + (input.direction === "up" ? -1 : 1);
            if (destination < 0 || destination >= stages.length) return plan;
            stages.splice(index, 1);
            stages.splice(destination, 0, stage);
          } else {
            if (input.before === stageId) return plan;
            stages.splice(index, 1);
            stages.splice(this.beforeIndex(stages, input.before), 0, stage);
          }
        }
      }
      return this.entities.update(plan.id, "work-plan", { stages }, options);
    });
  }

  stageTask(
    ref: string,
    stageId: string,
    task: string,
    remove: boolean,
    options: WriteOptions,
  ): EntityRecord {
    return this.db.transaction(() => {
      const plan = this.get("work-plan", ref);
      this.writable(plan, options);
      if (typeof remove !== "boolean") invalid("remove должен быть логическим значением.");
      const stages = this.stages(plan);
      const stage = stages[this.stageIndex(stages, reference(stageId, "stageId"))]!;
      const taskId = this.entities.get(reference(task, "task"), "task").id;
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
      return this.entities.update(plan.id, "work-plan", { stages }, options);
    });
  }

  transfer(
    ref: string,
    input: Record<string, unknown>,
    options: WriteOptions & { targetRevision: number },
  ): { source: EntityRecord; target: EntityRecord } {
    return this.db.transaction(() => {
      object(input, ["task", "targetPlan", "targetStage", "reason"]);
      object(options, ["actor", "ifRevision", "targetRevision"]);
      const source = this.get("work-plan", ref);
      const target = this.get("work-plan", reference(input.targetPlan, "targetPlan"));
      const sourceOptions = { actor: options.actor, ifRevision: options.ifRevision };
      const targetOptions = { actor: options.actor, ifRevision: revision(options.targetRevision) };
      this.writable(source, sourceOptions);
      this.writable(target, targetOptions);
      text(input.reason, "reason", 16 * 1024, true);
      const taskId = this.entities.get(reference(input.task, "task"), "task").id;
      const sourceStages = this.stages(source);
      const targetStages = source.id === target.id ? sourceStages : this.stages(target);
      const sourceStage = sourceStages.find((stage) => stage.taskIds.includes(taskId));
      if (!sourceStage) throw new RelayError("NOT_FOUND", "Задача не включена в исходный план.", 3);
      const targetStage =
        targetStages[this.stageIndex(targetStages, reference(input.targetStage, "targetStage"))]!;
      this.assertAvailable(taskId, source.id, sourceStage.id);
      if (source.id === target.id && sourceStage.id === targetStage.id) return { source, target };
      if (targetStage.taskIds.length >= 2000) invalid("В этапе допускается не более 2000 задач.");
      sourceStage.taskIds = sourceStage.taskIds.filter((id) => id !== taskId);
      targetStage.taskIds.push(taskId);
      // Обе записи входят в одну транзакцию: отказ второй не оставляет задачу вне планов.
      const savedSource = this.entities.update(
        source.id,
        "work-plan",
        { stages: sourceStages },
        sourceOptions,
      );
      const savedTarget =
        source.id === target.id
          ? savedSource
          : this.entities.update(target.id, "work-plan", { stages: targetStages }, targetOptions);
      return { source: savedSource, target: savedTarget };
    });
  }

  progress(kind: PlanningKind, ref: string): Record<string, unknown> {
    return this.db.snapshot(() => {
      const entity = this.get(kind, ref);
      return kind === "work-plan" ? this.planProgress(entity) : this.releaseProgress(entity);
    });
  }

  private kind(kind: PlanningKind): void {
    if (kind !== "work-plan" && kind !== "release")
      invalid("Допустимы только work-plan и release.");
  }

  private writable(entity: EntityRecord, options: WriteOptions): void {
    object(options, ["actor", "ifRevision"]);
    author(options.actor);
    const expected = revision(options.ifRevision);
    // Проверка до no-op исключает ложный успех устаревшего редактора.
    if (entity.revision !== expected) {
      throw new RelayError(
        "REVISION_CONFLICT",
        "Запись изменена; перечитайте её перед записью.",
        4,
        {
          id: entity.id,
          expectedRevision: expected,
          actualRevision: entity.revision,
        },
      );
    }
    if (entity.kind === "work-plan" && !openPlan(entity)) {
      throw new RelayError("PLAN_READ_ONLY", "Закрытый план доступен только для чтения.", 4);
    }
    if (entity.kind === "release" && entity.data.status === "released") {
      throw new RelayError("RELEASE_READ_ONLY", "Выпущенный релиз неизменяем.", 4);
    }
  }

  private fields(
    kind: PlanningKind,
    input: Record<string, unknown>,
    create: boolean,
    current?: EntityRecord,
  ): Record<string, unknown> {
    object(input, kind === "work-plan" ? planFields : releaseFields);
    const result: Record<string, unknown> = {};
    if (create || Object.hasOwn(input, "title"))
      result.title = text(input.title, "title", 160, true, true);
    for (const field of [
      "summary",
      ...(kind === "work-plan"
        ? ["goal", "rationale", "boundaries", "expectedResult"]
        : ["description"]),
    ]) {
      if (Object.hasOwn(input, field))
        result[field] = text(input[field], field, field === "summary" ? 16 * 1024 : 256 * 1024);
    }
    if (kind === "work-plan") {
      if (Object.hasOwn(input, "participants")) {
        if (!Array.isArray(input.participants) || input.participants.length > 100)
          invalid("participants — массив до 100 участников.");
        const participants = Array.from(input.participants, (actor) =>
          text(actor, "participants", 160, true, true),
        );
        if (new Set(participants).size !== participants.length)
          invalid("Участники не должны повторяться.");
        result.participants = participants;
      }
      if (Object.hasOwn(input, "scope")) {
        if (!Array.isArray(input.scope) || input.scope.length > 100)
          invalid("scope — массив до 100 областей воздействия.");
        const scope = Array.from(input.scope, (item) => {
          const entry = object(item, ["kind", "id"]);
          if (!scopeKinds.has(entry.kind as EntityKind))
            invalid("Недопустимый вид области воздействия.");
          const target = this.entities.get(
            reference(entry.id, "scope.id"),
            entry.kind as EntityKind,
          );
          return { kind: target.kind, id: target.id };
        });
        if (new Set(scope.map((entry) => entry.id)).size !== scope.length)
          invalid("Области воздействия не должны повторяться.");
        result.scope = scope;
      }
    } else {
      if (create || Object.hasOwn(input, "version"))
        result.version = text(input.version, "version", 80, true, true);
      if (create || Object.hasOwn(input, "planIds")) {
        const previous = current ? new Set(this.planIds(current)) : new Set<string>();
        result.planIds = this.resolvePlans(input.planIds, previous);
      }
      if (Object.hasOwn(input, "plannedFor")) {
        const date = text(input.plannedFor, "plannedFor", 10);
        if (
          date &&
          (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
            Number.isNaN(Date.parse(date)) ||
            new Date(date).toISOString().slice(0, 10) !== date)
        ) {
          invalid("plannedFor должен быть календарной датой YYYY-MM-DD либо пустой строкой.");
        }
        result.plannedFor = date;
      }
    }
    return result;
  }

  private stageFields(input: Record<string, unknown>, create: boolean): Partial<PlanStage> {
    const result: Partial<PlanStage> = {};
    if (create || Object.hasOwn(input, "title"))
      result.title = text(input.title, "title", 160, true, true);
    if (Object.hasOwn(input, "summary")) result.summary = text(input.summary, "summary", 16 * 1024);
    if (Object.hasOwn(input, "outcome")) result.outcome = text(input.outcome, "outcome");
    if (Object.hasOwn(input, "completionConditions"))
      result.completionConditions = text(input.completionConditions, "completionConditions");
    return result;
  }

  private resolvePlans(value: unknown, previous = new Set<string>()): string[] {
    if (!Array.isArray(value) || value.length < 1 || value.length > 200)
      invalid("planIds должен содержать от 1 до 200 ссылок на планы.");
    // Проверяем и пропуски разреженного массива, иначе JSON сохранит их как null.
    const ids = Array.from(value, (ref) => {
      const plan = this.get("work-plan", reference(ref, "planIds"));
      if (plan.data.status === "cancelled" && !previous.has(plan.id)) {
        throw new RelayError("INVALID_PLAN", "Нельзя включить отменённый план в релиз.", 4, {
          id: plan.id,
        });
      }
      return plan.id;
    });
    if (new Set(ids).size !== ids.length)
      invalid("Планы в составе релиза не должны повторяться, включая ссылки по ключу и ID.");
    return ids;
  }

  private stages(plan: EntityRecord): PlanStage[] {
    const value = plan.data.stages;
    if (!Array.isArray(value))
      throw new RelayError("INVALID_DATA", "Повреждён состав этапов плана.", 1);
    const stageIds = new Set<string>();
    const taskIds = new Set<string>();
    for (const stage of value) {
      if (
        !stage ||
        typeof stage !== "object" ||
        typeof stage.id !== "string" ||
        !stage.id ||
        stageIds.has(stage.id) ||
        !Array.isArray(stage.taskIds)
      ) {
        throw new RelayError("INVALID_DATA", "Повреждён этап плана.", 1);
      }
      stageIds.add(stage.id);
      for (const id of stage.taskIds) {
        if (typeof id !== "string" || !id || taskIds.has(id)) {
          throw new RelayError(
            "INVALID_DATA",
            "Повреждены или повторяются включения задач в план.",
            1,
          );
        }
        taskIds.add(id);
      }
    }
    return structuredClone(value) as PlanStage[];
  }

  private planIds(release: EntityRecord): string[] {
    const ids = release.data.planIds;
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.some((id) => typeof id !== "string" || !id) ||
      new Set(ids).size !== ids.length
    ) {
      throw new RelayError("INVALID_DATA", "Повреждён состав релиза.", 1);
    }
    return ids as string[];
  }

  private stageIndex(stages: PlanStage[], stageId: string): number {
    const index = stages.findIndex((stage) => stage.id === stageId);
    if (index < 0)
      throw new RelayError("NOT_FOUND", "Этап не найден в указанном плане.", 3, { stageId });
    return index;
  }

  private beforeIndex(stages: PlanStage[], before: unknown): number {
    return before === null ? stages.length : this.stageIndex(stages, reference(before, "before"));
  }

  private assertAvailable(taskId: string, planId: string, stageId: string): void {
    // Исторический состав закрытого плана не препятствует новому текущему включению.
    for (const plan of this.entities.list("work-plan")) {
      if (!openPlan(plan)) continue;
      for (const stage of this.stages(plan)) {
        if (stage.taskIds.includes(taskId) && (plan.id !== planId || stage.id !== stageId)) {
          throw new RelayError(
            "MEMBERSHIP_CONFLICT",
            "Задача уже включена в другой открытый план или этап; используйте явный перенос.",
            4,
            {
              taskId,
              planId: plan.id,
              stageId: stage.id,
            },
          );
        }
      }
    }
  }

  private planProgress(plan: EntityRecord): PlanProgress {
    const stages = this.stages(plan).map((stage) => {
      let completed = 0;
      const blockers = new Set<string>();
      for (const taskId of stage.taskIds) {
        const progress = this.tasks.progress(taskId);
        if (progress.completed) completed += 1;
        else {
          blockers.add(taskId);
          for (const blocker of progress.blockers) blockers.add(blocker);
        }
      }
      return {
        id: stage.id,
        completed: stage.taskIds.length > 0 && completed === stage.taskIds.length,
        counts: counts(stage.taskIds.length, completed),
        blockers: [...blockers],
      };
    });
    const total = stages.reduce((sum, stage) => sum + stage.counts.total, 0);
    const done = stages.reduce((sum, stage) => sum + stage.counts.completed, 0);
    // Пустой этап не готов, но не блокирует непустой фактически выполненный план.
    const completed = total > 0 && done === total;
    return {
      completed,
      canComplete: completed,
      counts: counts(total, done),
      stages,
      blockers: total ? [...new Set(stages.flatMap((stage) => stage.blockers))] : [plan.id],
    };
  }

  private releaseProgress(release: EntityRecord): ReleaseProgress {
    const plans = this.planIds(release).map((id) => {
      const plan = this.get("work-plan", id);
      const progress = this.planProgress(plan);
      const completed = plan.data.status === "completed" && progress.completed;
      return {
        id: plan.id,
        status: String(plan.data.status),
        completed,
        blockers: completed ? [] : [...new Set([plan.id, ...progress.blockers])],
      };
    });
    const done = plans.filter((plan) => plan.completed).length;
    const completed = plans.length > 0 && done === plans.length;
    // Статус выпущенного релиза не является снимком готовности связанных задач.
    return {
      completed,
      canRelease: completed,
      counts: counts(plans.length, done),
      plans,
      blockers: [...new Set(plans.flatMap((plan) => plan.blockers))],
    };
  }
}
