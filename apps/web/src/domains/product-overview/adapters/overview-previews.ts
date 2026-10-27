import type { EntitySummary, TaskViewPage } from "@relay/contracts";
import { relayClient } from "infra/tasks-api";
import { mapAttentionTask, mapPlan, mapRelease } from "../mappers/product-overview.mapper";
import { preview } from "../helpers/preview";
import { requireOverviewGeneration } from "../helpers/overview-generation";
import type { OverviewSources, OverviewPreviews } from "../types/overview-sources.type";
import type { OverviewPreview, OverviewTask } from "../types/product-overview.type";

/**
 * Читает не более пяти планов и десяти релизов; их готовность рассчитывает Core.
 * Имена досок и первых блокеров всех групп получаются одним summary getMany вместо
 * N полных адресных чтений. Проверяется исходное поколение общего обзора.
 */
export async function readOverviewPreviews(
  project: string,
  sources: OverviewSources,
): Promise<OverviewPreviews> {
  const { plans, planned, released, working, review, blocked } = sources;
  const references = [
    ...new Set(
      [working, review, blocked].flatMap((page) =>
        page.items.flatMap((task) => [task.boardId, ...task.progress.blockers.slice(0, 5)]),
      ),
    ),
  ];
  const names = new Map<string, EntitySummary>();
  if (references.length > 0) {
    const { data } = await relayClient.read(project, "getMany", {
      query: { ref: references, summary: true },
    });
    requireOverviewGeneration(working.generation, data.generation);
    if (data.view !== "summary") throw new Error("Ожидались краткие карточки контекста задач.");
    for (const item of data.items) {
      if (!item.ok) throw new Error(item.error.message, { cause: item.error });
      names.set(item.entity.id, item.entity);
    }
  }
  /**
   * Представляет уже полученные компактные задачи без дополнительных запросов.
   */
  const taskPreview = (source: TaskViewPage): OverviewPreview<OverviewTask> =>
    preview(
      source,
      source.items.map((task) => mapAttentionTask(task, names)),
    );
  const [activePlanItems, plannedItems, releasedItems] = await Promise.all([
    Promise.all(
      plans.items
        .filter((item) => item.kind === "work-plan")
        .map(async (plan) =>
          mapPlan(plan, (await relayClient.read(project, "planProgress", { ref: plan.id })).data),
        ),
    ),
    Promise.all(
      planned.items
        .filter((item) => item.kind === "release")
        .map(async (release) =>
          mapRelease(
            release,
            (await relayClient.read(project, "releaseProgress", { ref: release.id })).data,
          ),
        ),
    ),
    Promise.all(
      released.items
        .filter((item) => item.kind === "release")
        .map(async (release) =>
          mapRelease(
            release,
            (await relayClient.read(project, "releaseProgress", { ref: release.id })).data,
          ),
        ),
    ),
  ]);
  return {
    activePlanItems,
    plannedItems,
    releasedItems,
    attention: {
      inProgress: taskPreview(working),
      review: taskPreview(review),
      blocked: taskPreview(blocked),
    },
  };
}
