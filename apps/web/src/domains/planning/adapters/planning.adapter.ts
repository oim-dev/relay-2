import {
  PLAN_SCOPE_KINDS,
  PLAN_STATUSES,
  type BatchResult,
  type NamedCommand,
  type TaskCandidate,
} from "@relay/contracts";
import { relayClient, RelayApiError } from "infra/tasks-api";
import {
  readEntity,
  readPage,
  writeCommand,
  writeCommands,
  UncertainWriteError,
} from "domains/relay-data";
import { planningView, stageView } from "../helpers/planning-view";
import type {
  PlanningPlan,
  PlanStage,
  PlanningTask,
  PlanningPage,
  PlanFilters,
  PlanningTaskFilters,
  PlanningSaved,
} from "../types/planning.type";

/**
 * Предусмотренный отказ планирования с сохранением исходного ввода.
 */
export class PlanningError extends Error {
  /**
   * Сохраняет код и исходную причину SDK.
   */
  constructor(
    message: string,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * Преобразует ожидаемые ошибки SDK, не поглощая нарушения формы ответа.
 */
async function request<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof RelayApiError || error instanceof UncertainWriteError)
      throw new PlanningError(error.message, error.code, { cause: error });
    throw error;
  }
}

/**
 * Проверяет неизменность поколения вокруг составных чтений до общей проекции API.
 */
async function snapshot<T>(
  project: string,
  read: () => Promise<T>,
): Promise<{ value: T; generation: number }> {
  const start = (await relayClient.read(project, "projectStatus", {})).data.generation;
  const value = await read();
  if ((await relayClient.read(project, "projectStatus", {})).data.generation !== start)
    throw new PlanningError("Данные изменились. Повторите чтение", "PAGE_CHANGED");
  return { value, generation: start };
}

/**
 * Получает карточку плана и её готовность; вызывающий проверяет общий snapshot.
 */
async function planView(project: string, ref: string): Promise<PlanningPlan> {
  const plan = await readEntity(project, ref);
  if (plan.kind !== "work-plan")
    throw new PlanningError("Выбранная сущность не является планом", "INVALID_ARGUMENT");
  return planningView(
    plan,
    (await relayClient.read(project, "planProgress", { ref: plan.id })).data,
  );
}

/**
 * Читает раскрытую часть каталога и точные totals фильтров. Планы не выгружаются ради счётчиков.
 */
export function getPlans(
  project: string,
  filters: PlanFilters,
  count = 12,
): Promise<PlanningPage<PlanningPlan> & { statusCounts: Record<string, number> }> {
  const query = { ...filters, q: filters.q?.trim() ? filters.q : undefined };
  return request(async () => {
    const result = await snapshot(project, async () => {
      let page = await readPage(project, {
        kind: "work-plan",
        ...query,
        limit: Math.min(count, 100),
      });
      const records = [...page.items];
      while (page.nextOffset !== null && records.length < count) {
        page = await readPage(project, {
          kind: "work-plan",
          ...query,
          offset: page.nextOffset,
          generation: page.generation,
          limit: Math.min(count - records.length, 100),
        });
        records.push(...page.items);
      }
      const counts = await Promise.all(
        [undefined, ...PLAN_STATUSES].map(
          async (status) =>
            [
              status ?? "all",
              (await readPage(project, { kind: "work-plan", q: query.q, status, limit: 1 })).total,
            ] as const,
        ),
      );
      const items = await Promise.all(
        records.map(async (plan) => {
          if (plan.kind !== "work-plan") throw new Error("Сервер вернул не план");
          return planningView(
            plan,
            (await relayClient.read(project, "planProgress", { ref: plan.id })).data,
          );
        }),
      );
      return {
        items,
        total: page.total,
        nextOffset: page.nextOffset,
        statusCounts: Object.fromEntries(counts),
      };
    });
    return { ...result.value, version: String(result.generation) };
  });
}

/**
 * Читает адресный план и текущую готовность без смешения поколений.
 */
export function getPlan(project: string, reference: string): Promise<PlanningPlan> {
  return request(async () => (await snapshot(project, () => planView(project, reference))).value);
}

/**
 * API возвращает полный состав этапов; count ограничивает вывод, а не загрузку.
 */
export function getPlanStages(
  project: string,
  reference: string,
  count = 12,
): Promise<PlanningPage<PlanStage> & { planRevision: number }> {
  return request(async () => {
    const result = await snapshot(project, async () => {
      const stages = (await relayClient.read(project, "planStages", { ref: reference })).data;
      const progress = (await relayClient.read(project, "planProgress", { ref: reference })).data;
      return {
        items: stages.items.slice(0, count).map((stage) => {
          const state = progress.stages.find((item) => item.id === stage.id);
          if (!state) throw new PlanningError("Состав этапов изменился", "PAGE_CHANGED");
          return stageView(stage, state);
        }),
        total: stages.items.length,
        nextOffset: count < stages.items.length ? count : null,
        planRevision: stages.revision,
      };
    });
    return { ...result.value, version: String(result.generation) };
  });
}

/**
 * Присоединяет готовность и актуальное включение задачи из Core, не вычисляя граф на клиенте.
 */
function candidateView(task: TaskCandidate): PlanningTask {
  return {
    id: task.id,
    key: task.key,
    title: task.title,
    board: task.boardSlug,
    status: task.column,
    isCompleted: task.progress.completed,
    ...(task.progress.blockers.length ? { blocker: task.progress.blockers.join(", ") } : {}),
    assignment: task.assignment
      ? {
          planId: task.assignment.planId,
          stageId: task.assignment.stageId,
          label: `${task.assignment.planKey} · ${task.assignment.stageTitle}`,
        }
      : null,
  };
}

/**
 * Читает ID состава и только раскрытое окно компактных карточек, не выгружая их полные тела.
 */
export function getPlanStageTasks(
  project: string,
  reference: string,
  stage: string,
  count = 12,
): Promise<PlanningPage<PlanningTask>> {
  return request(async () => {
    const result = await snapshot(project, async () => {
      const tasks = (
        await relayClient.read(project, "planStage", { ref: reference, stageId: stage })
      ).data.stage.taskIds;
      const selected = tasks.slice(0, count);
      const items = new Map<string, PlanningTask>();
      for (let start = 0; start < selected.length; start += 100) {
        const page = (
          await relayClient.read(project, "taskCandidates", {
            query: { refs: selected.slice(start, start + 100), limit: 100 },
          })
        ).data;
        for (const task of page.items) items.set(task.id, candidateView(task));
      }
      return {
        items: selected.map((id) => {
          const item = items.get(id);
          if (!item) throw new PlanningError("Задача состава не найдена", "NOT_FOUND");
          return item;
        }),
        total: tasks.length,
        nextOffset: count < tasks.length ? count : null,
      };
    });
    return { ...result.value, version: String(result.generation) };
  });
}

/**
 * Читает только раскрытый объём кандидатов; Core фильтрует доступность до окна.
 * Продолжение передаёт исходное поколение и не смешивает изменившийся состав.
 */
export function getPlanningCandidates(
  project: string,
  filters: PlanningTaskFilters,
  count = 12,
): Promise<PlanningPage<PlanningTask>> {
  return request(async () => {
    const query = {
      q: filters.q,
      board: filters.board,
      plan: filters.plan,
      stageId: filters.stage,
      availableOnly: filters.isAvailableOnly,
    };
    let page = (
      await relayClient.read(project, "taskCandidates", {
        query: { ...query, limit: Math.min(count, 100) },
      })
    ).data;
    const items = page.items.map(candidateView);
    while (page.nextOffset !== null && items.length < count) {
      page = (
        await relayClient.read(project, "taskCandidates", {
          query: {
            ...query,
            offset: page.nextOffset,
            generation: page.generation,
            limit: Math.min(count - items.length, 100),
          },
        })
      ).data;
      items.push(...page.items.map(candidateView));
    }
    return {
      items,
      total: page.total,
      nextOffset: page.nextOffset,
      version: String(page.generation),
    };
  });
}

/**
 * Берёт ID и CAS владельца из первоначальной квитанции, включая вложенные операции.
 */
function saved(result: BatchResult): PlanningSaved {
  const owner = result.items.at(-1)?.owner;
  if (!owner) throw new Error("Пустая квитанция планирования");
  return { id: owner.id, key: owner.key, revision: owner.revision };
}

/**
 * Сохраняет только тексты и область формы с её исходным CAS.
 */
export function savePlan(project: string, plan: PlanningPlan): Promise<PlanningSaved> {
  const scope = plan.scope.map((value) => {
    const separator = value.indexOf(":");
    const kind = PLAN_SCOPE_KINDS.find((kind) => kind === value.slice(0, separator));
    if (!kind || separator < 0)
      throw new PlanningError("Недопустимый вид области плана", "INVALID_ARGUMENT");
    return { kind, id: value.slice(separator + 1) };
  });
  const input = {
    title: plan.title,
    summary: plan.summary,
    goal: plan.goal,
    rationale: plan.rationale,
    boundaries: plan.boundaries,
    expectedResult: plan.expectedResult,
    participants: plan.participants,
    scope,
  };
  return request(async () =>
    saved(
      await writeCommand(
        project,
        plan.revision === 0
          ? { op: "plan.create", input }
          : { op: "plan.update", ref: plan.id, ifRevision: plan.revision, input },
      ),
    ),
  );
}

/**
 * Изменяет этап под исходной ревизией плана, включая no-op перестановки.
 */
export function changePlanStage(
  project: string,
  planId: string,
  revision: number,
  action: "create" | "update" | "remove" | "move",
  stage: PlanStage,
  before?: string | null,
  direction?: "up" | "down",
): Promise<PlanningSaved> {
  const input = {
    ...(action === "create" ? {} : { stageId: stage.id }),
    ...(action === "create" || action === "update"
      ? {
          title: stage.title,
          summary: stage.summary,
          outcome: stage.outcome,
          completionConditions: stage.completionConditions,
        }
      : {}),
    ...(action === "move"
      ? direction === undefined
        ? { before: before ?? null }
        : { direction }
      : {}),
  };
  return request(async () =>
    saved(
      await writeCommand(project, {
        op: `plan.stage.${action}`,
        ref: planId,
        ifRevision: revision,
        input,
      }),
    ),
  );
}

/**
 * Применяет разницу полного выбора одним batch; каждый следующий шаг использует CAS предыдущего.
 * Пустая разница не отправляет мутацию. Скрытые выбором задачи остаются в selectedIds.
 */
export async function changePlanTasks(
  project: string,
  planId: string,
  revision: number,
  stage: PlanStage,
  selectedIds: string[],
): Promise<PlanningSaved | null> {
  const changes = [
    ...stage.taskIds
      .filter((id) => !selectedIds.includes(id))
      .map((task) => ({ action: "remove", task })),
    ...selectedIds
      .filter((id) => !stage.taskIds.includes(id))
      .map((task) => ({ action: "add", task })),
  ];
  if (changes.length === 0) return null;
  const commands: NamedCommand[] = changes.map((change, index) => ({
    op: `plan.stage.task.${change.action}`,
    ref: planId,
    as: `step${index}`,
    ifRevision: index === 0 ? revision : { $revision: `step${index - 1}` },
    input: { stageId: stage.id, task: change.task },
  }));
  return request(async () => saved(await writeCommands(project, commands)));
}

/**
 * Передаёт переход Core, который атомарно проверяет фактическую готовность.
 */
export function transitionPlan(
  project: string,
  planId: string,
  revision: number,
  action: "start" | "complete" | "cancel",
  result = "",
): Promise<PlanningSaved> {
  return request(async () =>
    saved(
      await writeCommand(project, {
        op: `plan.${action}`,
        ref: planId,
        ifRevision: revision,
        input: action === "start" ? {} : { result },
      }),
    ),
  );
}

/**
 * Переносит включение одной операцией Core с исходными CAS обеих сторон.
 */
export function transferPlanTask(
  project: string,
  source: PlanningPlan,
  target: PlanningPlan,
  task: string,
  targetStage: string,
  reason: string,
): Promise<PlanningSaved> {
  return request(async () =>
    saved(
      await writeCommand(project, {
        op: "plan.stage.task.transfer",
        ref: source.id,
        ifRevision: source.revision,
        input: {
          targetPlan: target.id,
          targetRevision: target.revision,
          task,
          targetStage,
          reason,
        },
      }),
    ),
  );
}
