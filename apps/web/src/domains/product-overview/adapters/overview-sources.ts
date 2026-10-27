import type {
  HttpEntityQuery,
  HttpEntityPage,
  HttpOverview,
  TaskViewQuery,
  TaskViewPage,
} from "@relay/contracts";
import { relayClient } from "infra/tasks-api";
import type { OverviewSources } from "../types/overview-sources.type";
import { taskColumns } from "../helpers/task-columns";
import { requireOverviewGeneration } from "../helpers/overview-generation";
import { countRemainder } from "../helpers/count-remainder";

/**
 * Читает окна одного поколения. Пустой вид из исходного overview не перечитывается:
 * его точный нулевой total уже известен. Это не fallback при отказе чтения.
 * Фильтры и прогресс могут обходить полный набор на стороне Core, несмотря на limit.
 */
export async function readOverviewSources(
  project: string,
  overview: HttpOverview,
): Promise<OverviewSources> {
  const { generation } = overview;
  /**
   * Передаёт исходное поколение в Core до выборки, а не только сравнивает ответ.
   */
  const page = async (query: HttpEntityQuery): Promise<HttpEntityPage> => {
    if (overview.counts[query.kind] === 0)
      return { items: [], total: 0, generation, nextOffset: null };
    const { data } = await relayClient.entities(project, { limit: 5, ...query, generation });
    requireOverviewGeneration(generation, data.generation);
    if (data.items.some((item) => item.kind !== query.kind)) {
      throw new Error("Ответ подборки не соответствует виду или поколению обзора.");
    }
    return data;
  };
  /**
   * Компактные задачи не загружают описания и журналы. Готовность принадлежит Core.
   */
  const tasks = async (query: TaskViewQuery, total: number): Promise<TaskViewPage> => {
    if (total === 0)
      return {
        items: [],
        total: 0,
        generation,
        nextOffset: null,
        counts: {
          total: 0,
          completed: 0,
          allCompleted: false,
          targetedCompleted: 0,
          targetedTotal: 0,
          blocked: 0,
          columns: { inbox: 0, ready: 0, "in-progress": 0, review: 0, done: 0, cancelled: 0 },
        },
      };
    const { data } = await relayClient.read(project, "taskViews", {
      query: { limit: 5, sort: "updated", ...query, generation },
    });
    requireOverviewGeneration(generation, data.generation);
    if (data.total !== total) throw new Error("Подборка задач не соответствует исходному обзору.");
    return data;
  };
  const columns = taskColumns(overview.tasks.columns);
  if (
    Object.values(columns).reduce((sum, count) => sum + count, 0) !== overview.tasks.total ||
    overview.counts.task !== overview.tasks.total
  ) {
    throw new Error("Счётчики задач обзора не согласованы.");
  }
  const [
    passport,
    boards,
    plans,
    planned,
    released,
    pinned,
    working,
    review,
    blocked,
    draftPlans,
    cancelledPlans,
    draftDocs,
    archivedDocs,
    frontends,
    backends,
    unsectioned,
    allPinned,
  ] = await Promise.all([
    page({ kind: "product", limit: 1 }),
    page({ kind: "board" }),
    page({ kind: "work-plan", status: "active" }),
    page({ kind: "release", status: "planned" }),
    page({ kind: "release", status: "released", sort: "updated" }),
    page({ kind: "document", pinned: true, documentStatus: "active", sort: "updated" }),
    tasks({ column: "in-progress" }, columns["in-progress"]),
    tasks({ column: "review" }, columns.review),
    tasks({ readiness: "blocked" }, overview.tasks.blocked),
    page({ kind: "work-plan", status: "draft", limit: 1 }),
    page({ kind: "work-plan", status: "cancelled", limit: 1 }),
    page({ kind: "document", documentStatus: "draft", limit: 1 }),
    page({ kind: "document", documentStatus: "archived", limit: 1 }),
    page({ kind: "application", type: "frontend", limit: 1 }),
    page({ kind: "application", type: "backend", limit: 1 }),
    page({ kind: "document", section: "none", limit: 1 }),
    page({ kind: "document", pinned: true, limit: 1 }),
  ]);
  // Статусы/типы — закрытые непересекающиеся категории Core, не показатели готовности.
  // Четыре лишних запроса ради последней категории заменяются точной арифметикой totals.
  const completedPlans = countRemainder(
    overview.counts["work-plan"],
    plans.total,
    draftPlans.total,
    cancelledPlans.total,
  );
  const cancelledReleases = countRemainder(overview.counts.release, planned.total, released.total);
  const activeDocs = countRemainder(overview.counts.document, draftDocs.total, archivedDocs.total);
  const internals = countRemainder(overview.counts.application, frontends.total, backends.total);
  return {
    passport,
    boards,
    plans,
    planned,
    released,
    pinned,
    working,
    review,
    blocked,
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
  };
}
