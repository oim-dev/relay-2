import type { HttpEntityPage, TaskViewPage } from "@relay/contracts";
import type { OverviewPlan, OverviewRelease, ProductOverview } from "./product-overview.type";

/**
 * Точный счётчик того же поколения; не притворяется страницей с отсутствующими карточками.
 */
export interface OverviewCount {
  /* Полное число записей соответствующей непересекающейся категории. */
  readonly total: number;
}

/**
 * Ограниченные подборки и счётчики одного проверенного поколения проекта.
 */
export interface OverviewSources {
  /* Единственный паспорт продукта. */
  passport: HttpEntityPage;
  /* Первые пять досок. */
  boards: HttpEntityPage;
  /* Первые пять активных планов. */
  plans: HttpEntityPage;
  /* Первые пять запланированных релизов. */
  planned: HttpEntityPage;
  /* Первые пять выпущенных релизов. */
  released: HttpEntityPage;
  /* Первые пять закреплённых действующих документов. */
  pinned: HttpEntityPage;
  /* Подборка задач в работе. */
  working: TaskViewPage;
  /* Подборка задач на проверке. */
  review: TaskViewPage;
  /* Подборка задач с блокерами. */
  blocked: TaskViewPage;
  /* Счётчик черновых планов. */
  draftPlans: OverviewCount;
  /* Счётчик завершённых планов. */
  completedPlans: OverviewCount;
  /* Счётчик отменённых планов. */
  cancelledPlans: OverviewCount;
  /* Счётчик отменённых релизов. */
  cancelledReleases: OverviewCount;
  /* Счётчик документов-черновиков. */
  draftDocs: OverviewCount;
  /* Счётчик действующих документов. */
  activeDocs: OverviewCount;
  /* Счётчик архивных документов. */
  archivedDocs: OverviewCount;
  /* Счётчик клиентских приложений. */
  frontends: OverviewCount;
  /* Счётчик серверных приложений. */
  backends: OverviewCount;
  /* Счётчик внутренних приложений. */
  internals: OverviewCount;
  /* Счётчик документов без раздела. */
  unsectioned: OverviewCount;
  /* Счётчик всех закреплённых документов. */
  allPinned: OverviewCount;
}

/**
 * Представления ограниченных подборок с адресацией и фактическим прогрессом Core.
 */
export interface OverviewPreviews {
  /* Активные планы. */
  activePlanItems: OverviewPlan[];
  /* Запланированные релизы. */
  plannedItems: OverviewRelease[];
  /* Выпущенные релизы. */
  releasedItems: OverviewRelease[];
  /* Группы задач с сохранёнными полными total. */
  attention: ProductOverview["attention"];
}
