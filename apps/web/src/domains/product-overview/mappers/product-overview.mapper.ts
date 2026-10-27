import type {
  KnowledgeRecord,
  WorkPlanRecord,
  ReleaseRecord,
  PlanProgress,
  ReleaseProgress,
  TaskView,
  EntitySummary,
} from "@relay/contracts";
import type {
  OverviewBoard,
  OverviewPassport,
  OverviewPlan,
  OverviewRelease,
  OverviewTask,
} from "../types/product-overview.type";

/**
 * Переводит существующий паспорт в заголовок исходной сцены обзора.
 */
export function mapPassport(entity: KnowledgeRecord<"product"> | undefined): OverviewPassport {
  if (entity === undefined || !entity.data.name) return { state: "missing" };
  const summary = entity.data.summary ?? "";
  const description = entity.data.description ?? "";
  return {
    state: summary === "" ? "no-summary" : "filled",
    key: entity.key,
    name: entity.data.name,
    revision: entity.revision,
    updatedAt: entity.updatedAt,
    text: summary || description.slice(0, 600),
    isExcerpt: summary === "",
    isTruncated: summary === "" && description.length > 600,
  };
}

/**
 * Готовит ссылку на доску; отсутствие её счётчиков не превращается в пустую доску.
 */
export function mapBoard(entity: KnowledgeRecord<"board">): OverviewBoard {
  return {
    id: entity.id,
    prefix: entity.data.prefix,
    slug: entity.data.slug,
    kind: entity.data.applicationId === undefined ? "product" : "application",
    name: entity.data.name,
    taskCount: null,
    openTaskCount: null,
  };
}

/**
 * Отображает компактную задачу и текущий прогресс Core без отдельного графа на строку.
 * Названия досок и первых блокеров принадлежат тому же проверенному поколению.
 */
export function mapAttentionTask(
  task: TaskView,
  names: ReadonlyMap<string, EntitySummary>,
): OverviewTask {
  const board = names.get(task.boardId);
  if (board?.kind !== "board") throw new Error("Не получено название доски задачи.");
  return {
    id: task.id,
    key: task.key,
    title: task.title,
    column: task.column,
    board: { slug: task.boardSlug, name: board.title },
    isCompleted: task.progress.completed,
    acceptance: task.acceptance,
    blockers: {
      total: task.progress.blockers.length,
      items: task.progress.blockers.slice(0, 5).map((id) => {
        const blocker = names.get(id);
        if (blocker?.kind !== "task") throw new Error("Не получена карточка блокирующей задачи.");
        return {
          id,
          key: blocker.key,
          title: blocker.title,
          column: blocker.state,
          relation: task.dependencies.includes(id) ? "dependency" : "subtask",
        };
      }),
    },
  };
}

/**
 * Сохраняет серверную готовность плана и геометрию его исходной карточки.
 */
export function mapPlan(plan: WorkPlanRecord, progress: PlanProgress): OverviewPlan {
  return {
    id: plan.id,
    key: plan.key,
    title: plan.data.title,
    description: plan.data.summary || plan.data.goal,
    stages: {
      total: progress.stages.length,
      completed: progress.stages.filter((stage) => stage.completed).length,
    },
    nextStageTitle:
      plan.data.stages.find((stage) =>
        progress.stages.some((item) => item.id === stage.id && !item.completed),
      )?.title ?? null,
    tasks: {
      total: progress.counts.total,
      completed: progress.counts.completed,
      blocked: progress.blockers.length,
      percent: progress.counts.percent,
    },
    isReady: progress.canComplete,
  };
}

/**
 * Отображает реальный состав и готовность релиза по проекции Core.
 */
export function mapRelease(release: ReleaseRecord, progress: ReleaseProgress): OverviewRelease {
  return {
    id: release.id,
    key: release.key,
    title: release.data.title,
    version: release.data.version,
    plannedFor: release.data.plannedFor || null,
    releasedAt: release.data.releasedAt,
    readiness: {
      total: progress.counts.total,
      ready: progress.counts.completed,
      percent: progress.counts.percent,
      canRelease: progress.canRelease,
    },
  };
}
