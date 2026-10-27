import { RELEASE_STATUSES, type NamedCommand } from "@relay/contracts";
import { relayClient, RelayApiError } from "infra/tasks-api";
import { readEntity, readPage, writeCommands, UncertainWriteError } from "domains/relay-data";
import type { PlanningPage } from "domains/planning";
import { releaseView, releasePlanView, releaseReadiness } from "../helpers/release-view";
import type { Release, ReleaseComposition, ReleaseFilters } from "../types/release.type";

/**
 * Предусмотренный отказ релиза; исходные guards и ввод формы не меняются.
 */
export class ReleaseError extends Error {
  /**
   * Сохраняет код SDK и первоначальную причину ошибки.
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
 * Сохраняет предметные ошибки и неизвестный исход записи для существующих форм.
 */
async function request<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof RelayApiError || error instanceof UncertainWriteError)
      throw new ReleaseError(error.message, error.code, { cause: error });
    throw error;
  }
}

/**
 * Не позволяет объединить карточки и готовность разных поколений проекта.
 */
async function snapshot<T>(
  project: string,
  read: () => Promise<T>,
): Promise<{ value: T; generation: number }> {
  const start = (await relayClient.read(project, "projectStatus", {})).data.generation;
  const value = await read();
  if ((await relayClient.read(project, "projectStatus", {})).data.generation !== start)
    throw new ReleaseError("Данные изменились. Повторите чтение", "PAGE_CHANGED");
  return { value, generation: start };
}

/**
 * Читает ограниченный каталог и отдельные totals фильтров без выгрузки всех релизов.
 */
export function getReleases(
  project: string,
  filters: ReleaseFilters,
  count = 12,
): Promise<PlanningPage<Release> & { statusCounts: Record<string, number> }> {
  const query = { ...filters, q: filters.q?.trim() ? filters.q : undefined };
  return request(async () => {
    const result = await snapshot(project, async () => {
      let page = await readPage(project, {
        kind: "release",
        ...query,
        limit: Math.min(count, 100),
      });
      const records = [...page.items];
      while (page.nextOffset !== null && records.length < count) {
        page = await readPage(project, {
          kind: "release",
          ...query,
          offset: page.nextOffset,
          generation: page.generation,
          limit: Math.min(count - records.length, 100),
        });
        records.push(...page.items);
      }
      const items = await Promise.all(
        records.map(async (release) => {
          if (release.kind !== "release") throw new Error("Сервер вернул не релиз");
          return releaseView(
            release,
            (await relayClient.read(project, "releaseProgress", { ref: release.id })).data,
          );
        }),
      );
      const counts = await Promise.all(
        [undefined, ...RELEASE_STATUSES].map(
          async (status) =>
            [
              status ?? "all",
              (await readPage(project, { kind: "release", q: query.q, status, limit: 1 })).total,
            ] as const,
        ),
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
 * Читает сохранённый релиз и его готовность, отклоняя смешанный снимок.
 */
export function getRelease(project: string, reference: string): Promise<Release> {
  return request(
    async () =>
      (
        await snapshot(project, async () => {
          const release = await readEntity(project, reference);
          if (release.kind !== "release")
            throw new ReleaseError("Выбранная сущность не является релизом", "INVALID_ARGUMENT");
          return releaseView(
            release,
            (await relayClient.read(project, "releaseProgress", { ref: release.id })).data,
          );
        })
      ).value,
  );
}

/**
 * Читает полный состав через Core; count ограничивает отображение, не HTTP-загрузку.
 */
export function getReleasePlans(
  project: string,
  reference: string,
  count = 12,
): Promise<ReleaseComposition> {
  return request(async () => {
    const result = await snapshot(project, async () => {
      const plans = (await relayClient.read(project, "releasePlans", { ref: reference })).data
        .items;
      const progress = (await relayClient.read(project, "releaseProgress", { ref: reference }))
        .data;
      const items = await Promise.all(
        plans
          .slice(0, count)
          .map(async (plan) =>
            releasePlanView(
              plan,
              (await relayClient.read(project, "planProgress", { ref: plan.id })).data,
            ),
          ),
      );
      return {
        items,
        total: plans.length,
        nextOffset: count < plans.length ? count : null,
        readiness: releaseReadiness(progress),
      };
    });
    return { ...result.value, version: String(result.generation) };
  });
}

/**
 * Показывает выбранные планы без записи. Готовность несохранённого релиза отсутствует в API:
 * null сохраняет это различие, а publication проверяется Core при атомарном сохранении.
 */
export function getReleasePreview(project: string, planIds: string[]): Promise<ReleaseComposition> {
  return request(async () => {
    const result = await snapshot(project, async () =>
      Promise.all(
        planIds.slice(0, 12).map(async (id) => {
          const plan = await readEntity(project, id);
          if (plan.kind !== "work-plan")
            throw new ReleaseError("В составе выбран не план", "INVALID_ARGUMENT");
          return releasePlanView(
            plan,
            (await relayClient.read(project, "planProgress", { ref: plan.id })).data,
          );
        }),
      ),
    );
    return {
      items: result.value,
      total: planIds.length,
      nextOffset: planIds.length > 12 ? 12 : null,
      version: String(result.generation),
      readiness: null,
    };
  });
}

/**
 * Сохраняет тексты, состав и переход одной атомарной операцией, начиная с исходного CAS.
 * Следующий переход использует $revision результата, а не арифметику ревизий или свежий GET.
 */
export function saveRelease(
  project: string,
  release: Release,
): Promise<{ id: string; key: string; revision: number }> {
  const input = {
    title: release.title,
    version: release.version,
    summary: release.summary,
    description: release.description,
    planIds: release.planIds,
    plannedFor: release.plannedFor,
  };
  const commands: NamedCommand[] = [
    release.revision === 0
      ? { op: "release.create", as: "release", input }
      : {
          op: "release.update",
          as: "release",
          ref: release.id,
          ifRevision: release.revision,
          input,
        },
  ];
  const actions = { planned: "plan", released: "publish", cancelled: "cancel" } as const;
  commands.push({
    op: `release.${actions[release.status]}`,
    ref: { $ref: "release" },
    ifRevision: { $revision: "release" },
  });
  return request(async () => {
    const result = await writeCommands(project, commands);
    const owner = result.items.at(-1)?.owner;
    if (!owner) throw new Error("Пустая квитанция релиза");
    return { id: owner.id, key: owner.key, revision: owner.revision };
  });
}
