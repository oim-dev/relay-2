import type { HttpOverview } from "@relay/contracts";
import type { ProductOverview } from "../types/product-overview.type";
import type { OverviewSources, OverviewPreviews } from "../types/overview-sources.type";
import { mapPassport, mapBoard } from "./product-overview.mapper";
import { preview } from "../helpers/preview";
import { taskColumns } from "../helpers/task-columns";

/**
 * Собирает исходную визуальную сцену из текущих данных. Отсутствующие агрегаты
 * представлены null, а не фиктивными нулями или старой формулой готовности.
 */
export function overviewScene(
  overview: HttpOverview,
  sources: OverviewSources,
  details: OverviewPreviews,
): ProductOverview {
  const {
    passport,
    boards,
    plans,
    planned,
    released,
    pinned,
    draftPlans,
    completedPlans,
    cancelledPlans,
    cancelledReleases,
    draftDocs,
    activeDocs,
    archivedDocs,
    frontends,
    backends,
    internals,
    unsectioned,
    allPinned,
  } = sources;
  return {
    snapshotVersion: String(overview.generation),
    generatedAt: new Date().toISOString(),
    project: { name: overview.project.data.name, slug: overview.project.data.slug },
    passport: mapPassport(passport.items.find((item) => item.kind === "product")),
    knowledge: {
      features: { total: overview.counts.feature, byStatus: null },
      scenarios: { total: overview.counts.scenario, byStatus: null },
      applications: {
        total: overview.counts.application,
        byType: { frontend: frontends.total, backend: backends.total, internal: internals.total },
      },
      featureImplementations: null,
      scenarioImplementations: null,
      implementationsTotal: overview.counts.implementation,
    },
    boards: {
      total: overview.counts.board,
      byKind: null,
      catalog: preview(boards, boards.items.filter((item) => item.kind === "board").map(mapBoard)),
    },
    tasks: {
      total: overview.tasks.total,
      byColumn: taskColumns(overview.tasks.columns),
      blocked: overview.tasks.blocked,
      completed: null,
      doneWithOpenObligations: null,
      readyToStart: null,
      criteria: null,
    },
    attention: details.attention,
    documents: {
      total: overview.counts.document,
      byStatus: { draft: draftDocs.total, active: activeDocs.total, archived: archivedDocs.total },
      pinned: allPinned.total,
      sections: {
        total: overview.project.data.documentSections?.length ?? 0,
        unsectioned: unsectioned.total,
      },
      pinnedActive: preview(
        pinned,
        pinned.items
          .filter((item) => item.kind === "document")
          .map((item) => ({
            id: item.id,
            key: item.key,
            name: item.data.name,
            summary: item.data.summary,
            updatedAt: item.updatedAt,
          })),
      ),
    },
    plans: {
      total: overview.counts["work-plan"],
      byStatus: {
        draft: draftPlans.total,
        active: plans.total,
        completed: completedPlans.total,
        cancelled: cancelledPlans.total,
      },
      completedNotReady: null,
      active: preview(plans, details.activePlanItems),
    },
    releases: {
      total: overview.counts.release,
      byStatus: {
        planned: planned.total,
        released: released.total,
        cancelled: cancelledReleases.total,
      },
      upcoming: preview(planned, details.plannedItems),
      recent: preview(released, details.releasedItems),
    },
    operator: null,
  };
}
