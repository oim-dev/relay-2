import type {
  ReleaseRecord,
  ReleaseProgress,
  WorkPlanRecord,
  PlanProgress,
} from "@relay/contracts";
import type { Release, ReleasePlanItem, ReleaseSummary } from "../types/release.type";

/**
 * Использует только серверную готовность, не выводит публикацию из статусов планов на клиенте.
 */
export function releaseReadiness(progress: ReleaseProgress): ReleaseSummary {
  // Core проверяет существование всех планов и возвращает ошибку при повреждённой ссылке.
  return {
    total: progress.counts.total,
    ready: progress.counts.completed,
    percent: progress.counts.percent,
    canRelease: progress.canRelease,
    missing: 0,
  };
}

/**
 * Адаптирует реквизиты релиза и готовность из одного проверенного поколения.
 */
export function releaseView(release: ReleaseRecord, progress: ReleaseProgress): Release {
  return {
    id: release.id,
    key: release.key,
    revision: release.revision,
    ...release.data,
    updatedAt: release.updatedAt,
    readiness: releaseReadiness(progress),
  };
}

/**
 * Подготавливает актуальную карточку плана, используя его собственный прогресс Core.
 */
export function releasePlanView(plan: WorkPlanRecord, progress: PlanProgress): ReleasePlanItem {
  return {
    id: plan.id,
    key: plan.key,
    title: plan.data.title,
    summary: plan.data.summary,
    goal: plan.data.goal,
    result: plan.data.result,
    status: plan.data.status,
    done: progress.counts.completed,
    total: progress.counts.total,
    percent: progress.counts.percent,
    isMissing: false,
  };
}

/**
 * Создаёт только локальный ввод формы; пустой новый состав не считается готовым.
 */
export function createReleaseDraft(): Release {
  return {
    id: "new",
    key: "Новый релиз",
    revision: 0,
    title: "",
    version: "",
    summary: "",
    description: "",
    planIds: [],
    status: "planned",
    plannedFor: "",
    releasedAt: null,
    releasedBy: null,
    updatedAt: new Date().toISOString(),
    readiness: { total: 0, ready: 0, missing: 0, percent: 0, canRelease: false },
  };
}

/**
 * Возвращает серверные показатели полного состава, независимо от раскрытого окна.
 */
export const getReleaseSummary = (release: Release): ReleaseSummary => release.readiness;
