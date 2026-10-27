import { useCallback, useEffect } from "react";
import useSWR, { useSWRConfig } from "swr";
import type { SWRResponse } from "swr";
import { subscribeWorkspace } from "infra/workspace-events";
import {
  getPlans,
  getPlan,
  getPlanStages,
  getPlanStageTasks,
  getPlanningCandidates,
} from "../adapters/planning.adapter";
import type {
  PlanningPlan,
  PlanningTask,
  PlanStage,
  PlanningPage,
  PlanFilters,
  PlanningTaskFilters,
} from "../types/planning.type";

/**
 * Перечитывает REST после изменения проекта и reconnect, сохраняя ввод в композициях.
 */
const usePlanningSync = (project: string, refresh: () => Promise<unknown>): void => {
  useEffect(() => {
    let isFirst = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeWorkspace(project, (signal) => {
      if (isFirst) {
        isFirst = false;
        return;
      }
      if (signal.state !== "connected") return;
      clearTimeout(timer);
      timer = setTimeout(() => void refresh().catch(() => undefined), 100);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [project, refresh]);
};

/**
 * Читает серверный каталог с фильтрами и полными счётчиками состояний.
 */
export const usePlans = (
  project: string,
  filters: PlanFilters = {},
  count = 12,
): SWRResponse<PlanningPage<PlanningPlan> & { statusCounts: Record<string, number> }, Error> => {
  const query = useSWR(["planning", project, "list", filters, count], () =>
    getPlans(project, filters, count),
  );
  usePlanningSync(project, query.mutate);
  return query;
};

/**
 * Получает адресный план; отсутствие ID выключает запрос.
 */
export const usePlan = (
  project: string,
  reference: string | null,
): SWRResponse<PlanningPlan, Error> => {
  const query = useSWR(reference === null ? null : ["planning", project, "plan", reference], () =>
    getPlan(project, reference ?? ""),
  );
  usePlanningSync(project, query.mutate);
  return query;
};

/**
 * Сохраняет раскрытый объём этапов после уведомления.
 */
export const usePlanStages = (
  project: string,
  planId: string,
  count = 12,
): SWRResponse<PlanningPage<PlanStage> & { planRevision: number }, Error> => {
  const query = useSWR(["planning", project, "stages", planId, count], () =>
    getPlanStages(project, planId, count),
  );
  usePlanningSync(project, query.mutate);
  return query;
};

/**
 * Задачи загружаются только для раскрытого этапа.
 */
export const usePlanStageTasks = (
  project: string,
  planId: string,
  stageId: string,
  count: number,
  isEnabled: boolean,
): SWRResponse<PlanningPage<PlanningTask>, Error> => {
  const query = useSWR(
    isEnabled ? ["planning", project, "tasks", planId, stageId, count] : null,
    () => getPlanStageTasks(project, planId, stageId, count),
  );
  usePlanningSync(project, query.mutate);
  return query;
};

/**
 * Выбор задач использует серверную фильтрацию до страницы.
 */
export const usePlanningCandidates = (
  project: string,
  filters: PlanningTaskFilters,
  count = 12,
): SWRResponse<PlanningPage<PlanningTask>, Error> => {
  const query = useSWR(["planning", project, "candidates", filters, count], () =>
    getPlanningCandidates(project, filters, count),
  );
  usePlanningSync(project, query.mutate);
  return query;
};

/**
 * После квитанции обновляет только проекции своего проекта.
 */
export const usePlanningRefresh = (project: string): (() => Promise<unknown>) => {
  const { mutate } = useSWRConfig();
  return useCallback(
    () => mutate((key) => Array.isArray(key) && key[0] === "planning" && key[1] === project),
    [mutate, project],
  );
};
