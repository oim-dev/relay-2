import { RelayError, validateEntityPageRequest } from "@relay/contracts";
import type {
  PlanningKind,
  PlanningRecord,
  WorkPlanRecord,
  ReleaseRecord,
  PlanProgress,
  ReleaseProgress,
  PlanStages,
  PlanStageResult,
  PlanStageTasks,
  TaskPlanMemberships,
  ReleasePlans,
  EntityPage,
  EntityPageRequest,
} from "@relay/contracts";
import type { ProjectDatabase } from "@relay/storage";
import { EntityService } from "./entities";
import { TasksService } from "./tasks";
import { decodePlanning, decodePlan, decodeRelease, stageIndex } from "./planning-data";
import { parsePlanningFilter, planningKind, reference } from "./planning-input";
import { planProgress, planTaskIds, releaseProgress } from "./planning-progress";
import { pageEntities } from "./entity-page";

function matches(record: PlanningRecord, q: string): boolean {
  const data = record.data;
  const texts = [record.id, record.key, data.title, data.summary];
  if (record.kind === "work-plan") {
    const plan = record.data;
    texts.push(plan.goal, plan.rationale, plan.boundaries, plan.expectedResult, plan.result);
    for (const stage of plan.stages)
      texts.push(stage.title, stage.summary, stage.outcome, stage.completionConditions);
  } else texts.push(record.data.version, record.data.description);
  return texts.some((value) => value.toLowerCase().includes(q));
}

/** Чтения планирования владеют декодированием и единым снимком всех связанных записей. */
export class PlanningQueries {
  protected readonly entities: EntityService;
  protected readonly tasks: TasksService;

  constructor(protected readonly db: ProjectDatabase) {
    this.entities = new EntityService(db);
    this.tasks = new TasksService(db);
  }

  /** Фильтр проверяется до чтения; недопустимый status возвращает INVALID_ARGUMENT. */
  list(kind: "work-plan", filter?: unknown): WorkPlanRecord[];
  list(kind: "release", filter?: unknown): ReleaseRecord[];
  list(kind: PlanningKind, filter?: unknown): PlanningRecord[];
  list(kind: PlanningKind, filter: unknown = {}): PlanningRecord[] {
    planningKind(kind);
    const query = parsePlanningFilter(kind, filter);
    return this.db.snapshot(() => {
      const exactId = query.q === undefined ? undefined : this.searchAddress(kind, query.q);
      return this.entities
        .list(kind)
        .map((record) => decodePlanning(record, this.db.projectId))
        .filter(
          (record) =>
            (query.status === undefined || record.data.status === query.status) &&
            (query.q === undefined ||
              record.id === exactId ||
              matches(record, query.q.toLowerCase())),
        );
    });
  }

  /**
   * Обычный список читает из Storage только окно записей; поиск и status требуют
   * полного предметного отбора. Состав страницы и total принадлежат одному снимку.
   */
  listPage(
    kind: "work-plan",
    filter: unknown,
    request: EntityPageRequest,
  ): EntityPage<WorkPlanRecord>;
  listPage(kind: "release", filter: unknown, request: EntityPageRequest): EntityPage<ReleaseRecord>;
  listPage(
    kind: PlanningKind,
    filter: unknown,
    request: EntityPageRequest,
  ): EntityPage<PlanningRecord>;
  listPage(
    kind: PlanningKind,
    filter: unknown,
    request: EntityPageRequest,
  ): EntityPage<PlanningRecord> {
    planningKind(kind);
    const query = parsePlanningFilter(kind, filter);
    validateEntityPageRequest(request);
    return this.db.snapshot(() => {
      if (query.q === undefined && query.status === undefined) {
        const page = this.db.listPage(kind, request);
        return {
          total: page.total,
          items: page.items.map((record) => decodePlanning(record, this.db.projectId)),
        };
      }
      return pageEntities(this.list(kind, query), request);
    });
  }

  get(kind: "work-plan", ref: string): WorkPlanRecord;
  get(kind: "release", ref: string): ReleaseRecord;
  get(kind: PlanningKind, ref: string): PlanningRecord;
  get(kind: PlanningKind, ref: string): PlanningRecord {
    planningKind(kind);
    const record = this.entities.get(reference(ref, "ref"), kind);
    return kind === "work-plan"
      ? decodePlan(record, this.db.projectId)
      : decodeRelease(record, this.db.projectId);
  }

  /** Этапы и ревизия владельца-плана читаются одним снимком; порядок сохраняется. */
  listStages(ref: string): PlanStages {
    return this.db.snapshot(() => {
      const plan = this.get("work-plan", ref);
      return { plan: plan.key, revision: plan.revision, items: plan.data.stages };
    });
  }

  /** Ревизия принадлежит плану и пригодна для CAS изменения этапа. */
  getStage(ref: string, stageId: string): PlanStageResult {
    return this.db.snapshot(() => {
      const plan = this.get("work-plan", ref);
      return {
        plan: plan.key,
        revision: plan.revision,
        stage: plan.data.stages[stageIndex(plan.data.stages, reference(stageId, "stageId"))]!,
      };
    });
  }

  /** Состав этапа и полные задачи берутся из общего снимка; revision — ревизия плана. */
  stageTasks(ref: string, stageId: string): PlanStageTasks {
    return this.db.snapshot(() => {
      const { plan, revision, stage } = this.getStage(ref, stageId);
      return { plan, revision, items: stage.taskIds.map((id) => this.tasks.get(id)) };
    });
  }

  /** Возвращает текущие и исторические включения; у каждого включения ревизия его плана. */
  memberships(taskRef: string): TaskPlanMemberships {
    return this.db.snapshot(() => {
      const task = this.tasks.get(reference(taskRef, "task"));
      const items = this.list("work-plan").flatMap((plan) =>
        plan.data.stages
          .filter((stage) => stage.taskIds.includes(task.id))
          .map((stage) => ({ plan: plan.key, revision: plan.revision, stage })),
      );
      return { task: task.key, items };
    });
  }

  /** Состав и планы читаются одним снимком; верхняя revision защищает состав релиза. */
  releasePlans(ref: string): ReleasePlans {
    return this.db.snapshot(() => {
      const release = this.get("release", ref);
      return {
        release: release.key,
        revision: release.revision,
        items: release.data.planIds.map((id) => this.get("work-plan", id)),
      };
    });
  }

  /** Актуальная готовность всего состава в одном снимке, с единственным расчётом графа задач. */
  progress(kind: "work-plan", ref: string): PlanProgress;
  progress(kind: "release", ref: string): ReleaseProgress;
  progress(kind: PlanningKind, ref: string): PlanProgress | ReleaseProgress;
  progress(kind: PlanningKind, ref: string): PlanProgress | ReleaseProgress {
    return this.db.snapshot(() => this.calculateProgress(this.get(kind, ref)));
  }

  /** Вызывается только внутри snapshot либо транзакции перехода состояния. */
  protected calculateProgress(record: PlanningRecord): PlanProgress | ReleaseProgress {
    const plans =
      record.kind === "work-plan"
        ? [record]
        : record.data.planIds.map((id) => this.get("work-plan", id));
    const progress = this.tasks.progressMany(planTaskIds(plans));
    return record.kind === "work-plan"
      ? planProgress(record, progress)
      : releaseProgress(plans, progress);
  }

  private searchAddress(kind: PlanningKind, query: string): string | undefined {
    try {
      return this.entities.get(query, kind).id;
    } catch (error) {
      if (
        !(error instanceof RelayError) ||
        !["NOT_FOUND", "INVALID_ARGUMENT", "VALIDATION_ERROR"].includes(error.code)
      )
        throw error;
      return undefined;
    }
  }
}
