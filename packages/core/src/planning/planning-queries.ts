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
import { EntityService } from "../entities/entities";
import { TasksService } from "../tasks/tasks";
import { decodePlanning, decodePlan, decodeRelease } from "./planning-data";
import { requireStage } from "./planning-rules";
import { parsePlanningFilter, planningKind } from "./planning-input";
import { reference } from "./planning-validation";
import { planProgress, planTaskIds, releaseProgress } from "./planning-progress";
import { pageEntities } from "../entities/entity-page";

/**
 * Ищет уже приведённый к нижнему регистру запрос в содержании записи и текстах этапов.
 * Связанные задачи и планы релиза в полнотекстовый поиск этой записи не входят.
 */
function matches(record: Readonly<PlanningRecord>, q: string): boolean {
  const data = record.data;
  const texts = [record.id, record.key, data.title, data.summary];
  if (record.kind === "work-plan") {
    const plan = record.data;
    texts.push(plan.goal, plan.rationale, plan.boundaries, plan.expectedResult, plan.result);
    for (const stage of plan.stages) {
      texts.push(stage.title, stage.summary, stage.outcome, stage.completionConditions);
    }
  } else {
    texts.push(record.data.version, record.data.description);
  }
  return texts.some((value) => value.toLowerCase().includes(q));
}

/**
 * Чтения планирования владеют декодированием и единым снимком всех связанных записей.
 * База принадлежит вызывающему коду; сервис не закрывает её и не кеширует результаты между вызовами.
 */
export class PlanningQueries {
  /* База текущего проекта, предоставляющая согласованные снимки и транзакции. */
  protected readonly db: ProjectDatabase;

  /* Общий владелец разрешения ID, ключей и алиасов сущностей. */
  protected readonly entities: EntityService;

  /* Предметное чтение задач и расчёт общего графа готовности. */
  protected readonly tasks: TasksService;

  /**
   * Подключает чтения к открытой базе проекта без получения владения её жизненным циклом.
   */
  constructor(db: ProjectDatabase) {
    this.db = db;
    this.entities = new EntityService(db);
    this.tasks = new TasksService(db);
  }

  /**
   * Читает все подходящие планы в общем снимке; результат сохраняет порядок Storage.
   */
  list(kind: "work-plan", filter?: unknown): WorkPlanRecord[];
  /**
   * Читает все подходящие релизы в общем снимке; результат сохраняет порядок Storage.
   */
  list(kind: "release", filter?: unknown): ReleaseRecord[];
  /**
   * Читает все записи выбранного вида с предметным фильтром.
   */
  list(kind: PlanningKind, filter?: unknown): PlanningRecord[];
  /**
   * Проверяет фильтр до чтения и загружает все записи вида перед отбором в одном снимке.
   * Поиск учитывает содержание и разрешаемый адрес; неверный status возвращает INVALID_ARGUMENT.
   */
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
   * Возвращает страницу планов и общее число подходящих записей из одного снимка.
   * Без фильтра загружает только окно Storage; поиск и статус требуют чтения всех планов.
   */
  listPage(
    kind: "work-plan",
    filter: unknown,
    request: Readonly<EntityPageRequest>,
  ): EntityPage<WorkPlanRecord>;
  /**
   * Возвращает страницу релизов и общее число подходящих записей из одного снимка.
   * Без фильтра загружает только окно Storage; поиск и статус требуют чтения всех релизов.
   */
  listPage(
    kind: "release",
    filter: unknown,
    request: Readonly<EntityPageRequest>,
  ): EntityPage<ReleaseRecord>;
  /**
   * Ограничивает выдачу записей выбранного вида проверенными параметрами страницы.
   * Фильтрация читает полный набор; без фильтра окно ограничивается непосредственно в Storage.
   */
  listPage(
    kind: PlanningKind,
    filter: unknown,
    request: Readonly<EntityPageRequest>,
  ): EntityPage<PlanningRecord>;
  /**
   * Без фильтра читает из Storage только окно записей; поиск и status требуют полного отбора.
   * Состав страницы и total принадлежат одному снимку. Фильтрованная страница ограничивает
   * выдачу, но не объём загрузки записей; параметры проверяются до обращения к БД.
   */
  listPage(
    kind: PlanningKind,
    filter: unknown,
    request: Readonly<EntityPageRequest>,
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

  /**
   * Разрешает ссылку на план и проверяет полное сохранённое содержание.
   */
  get(kind: "work-plan", ref: string): WorkPlanRecord;
  /**
   * Разрешает ссылку на релиз и проверяет полное сохранённое содержание.
   */
  get(kind: "release", ref: string): ReleaseRecord;
  /**
   * Читает проверенную запись выбранного вида по ID, ключу, алиасу или типизированной ссылке.
   */
  get(kind: PlanningKind, ref: string): PlanningRecord;
  /**
   * Читает запись через общий разрешитель адресов, сохраняя его снимок при конкурентном rename.
   * Отсутствие даёт NOT_FOUND, неверная сохранённая форма или проект — CORRUPT_DATA.
   */
  get(kind: PlanningKind, ref: string): PlanningRecord {
    planningKind(kind);
    const record = this.entities.get(reference(ref, "ref"), kind);
    return kind === "work-plan"
      ? decodePlan(record, this.db.projectId)
      : decodeRelease(record, this.db.projectId);
  }

  /**
   * Читает упорядоченные этапы и ревизию владельца-плана одним снимком.
   */
  listStages(ref: string): PlanStages {
    return this.db.snapshot(() => {
      const plan = this.get("work-plan", ref);
      return { plan: plan.key, revision: plan.revision, items: plan.data.stages };
    });
  }

  /**
   * Читает этап и ревизию его плана одним снимком; ревизия пригодна для CAS изменения этапа.
   * Отсутствующий этап возвращает NOT_FOUND без подмены пустым составом.
   */
  getStage(ref: string, stageId: string): PlanStageResult {
    return this.db.snapshot(() => {
      const plan = this.get("work-plan", ref);
      return {
        plan: plan.key,
        revision: plan.revision,
        stage: requireStage(plan.data.stages, reference(stageId, "stageId")),
      };
    });
  }

  /**
   * Читает состав этапа и полные карточки задач из общего снимка в порядке включения.
   * revision принадлежит плану; повреждённая ссылка не исключается из результата молча.
   */
  stageTasks(ref: string, stageId: string): PlanStageTasks {
    return this.db.snapshot(() => {
      const { plan, revision, stage } = this.getStage(ref, stageId);
      return { plan, revision, items: stage.taskIds.map((id) => this.tasks.get(id)) };
    });
  }

  /**
   * Возвращает текущие и исторические включения задачи с ревизией каждого плана.
   * Для отбора загружает все планы проекта в общем снимке; пустой список означает отсутствие включений.
   */
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

  /**
   * Читает состав релиза и полные планы одним снимком в порядке включения.
   * Верхняя revision защищает релиз, включая состав; каждый вложенный план имеет свою ревизию.
   */
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

  /**
   * Рассчитывает актуальную готовность явного состава плана независимо от его статуса.
   * План и один общий граф задач принадлежат согласованному снимку.
   * Для непустого состава читает обязательства всех задач проекта без их текстов и журналов.
   */
  progress(kind: "work-plan", ref: string): PlanProgress;
  /**
   * Рассчитывает актуальную готовность состава релиза с учётом завершённости его планов.
   * Весь состав и один общий граф задач принадлежат согласованному снимку.
   * Для непустого состава задач читает обязательства всех задач проекта без текстов и журналов.
   */
  progress(kind: "release", ref: string): ReleaseProgress;
  /**
   * Возвращает предметный прогресс выбранной записи без записи результата в БД.
   */
  progress(kind: PlanningKind, ref: string): PlanProgress | ReleaseProgress;
  /**
   * Рассчитывает готовность всего состава в одном снимке и с одним графом задач.
   * Пустой набор задач не читает граф; связанные обязательства проверяет TasksService.
   */
  progress(kind: PlanningKind, ref: string): PlanProgress | ReleaseProgress {
    return this.db.snapshot(() => this.calculateProgress(this.get(kind, ref)));
  }

  /**
   * Собирает уникальные задачи всего состава и один раз запрашивает их общий граф.
   * Вызывается только внутри snapshot либо транзакции перехода состояния; полные тексты
   * и журналы задач не нужны, а готовность не кешируется между операциями.
   * Непустой набор загружает обязательства всех задач проекта, а не только включённых в состав.
   */
  protected calculateProgress(record: Readonly<PlanningRecord>): PlanProgress | ReleaseProgress {
    const plans =
      record.kind === "work-plan"
        ? [record]
        : record.data.planIds.map((id) => this.get("work-plan", id));
    const progress = this.tasks.progressMany(planTaskIds(plans));
    return record.kind === "work-plan"
      ? planProgress(record, progress)
      : releaseProgress(plans, progress);
  }

  /**
   * Пытается дополнить текстовый поиск точным адресом записи.
   * Неразрешимая или синтаксически неверная строка остаётся обычным запросом;
   * повреждение хранения и неожиданные ошибки не скрываются.
   */
  private searchAddress(kind: PlanningKind, query: string): string | undefined {
    try {
      return this.entities.get(query, kind).id;
    } catch (error) {
      if (
        !(error instanceof RelayError) ||
        !["NOT_FOUND", "INVALID_ARGUMENT", "VALIDATION_ERROR"].includes(error.code)
      ) {
        throw error;
      }
      return undefined;
    }
  }
}
