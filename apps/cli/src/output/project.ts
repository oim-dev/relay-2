import { ENTITY_KINDS, type EntityKind } from "@relay/contracts";
import {
  configurationLabels,
  outputLabels,
  outputMessages,
  overviewKindLabels,
} from "../locales/output";
import type { Page } from "../pagination/pagination.types";
import type { OverviewPresentation, PagePresentation, Result } from "./output.types";
import { renderPage, renderPageContinuation } from "./pages";
import { isEntity, isObject, renderEntitySummary, renderFullValue, renderSummary } from "./values";

const overviewCountRows = [
  ["project", "product", "feature", "scenario"],
  ["application", "implementation", "board", "document"],
  ["task", "work-plan", "release", "work-session", "work-checkpoint"],
] as const satisfies readonly (readonly EntityKind[])[];

/**
 * Разделяет исходный конфиг и вычисленное расположение, уже полученное Runtime.
 * Не читает файлы повторно и сохраняет дополнительные поля исходной конфигурации.
 */
export function renderConfiguration(result: Result): string {
  const { configPath, databasePath } = result.meta ?? {};
  if (typeof configPath !== "string" || typeof databasePath !== "string") {
    return renderFullValue(result.data);
  }
  return [
    outputMessages.configurationSource,
    renderFullValue(result.data, configurationLabels),
    "",
    outputMessages.configurationLocation,
    outputMessages.field(outputLabels.configPath, configPath),
    outputMessages.field(outputLabels.databasePath, databasePath),
  ].join("\n");
}

/**
 * Проверяет только числовую форму счётчиков для представления, не пересчитывая предметные данные.
 */
function isCounts(value: unknown): value is Readonly<Record<string, number>> {
  return isObject(value) && Object.values(value).every((count) => typeof count === "number");
}

/**
 * Распознаёт минимальную форму обзора; неподдержанная форма получит обычное полное представление.
 */
function isOverview(data: PagePresentation): data is OverviewPresentation {
  const counts = data.counts;
  return (
    isEntity(data.project) &&
    typeof data.generation === "number" &&
    isCounts(counts) &&
    ENTITY_KINDS.every((kind) => typeof counts[kind] === "number") &&
    isObject(data.tasks) &&
    typeof data.tasks.total === "number" &&
    typeof data.tasks.blocked === "number" &&
    isCounts(data.tasks.columns)
  );
}

/**
 * Выводит глобальную сводку отдельно от окна карты без полных паспортов и повторов счётчика окна.
 * Использует только готовые агрегаты Core; продолжение страницы сохраняет исходный запрос.
 */
export function renderOverview(data: PagePresentation, page: Page): string {
  if (!isOverview(data)) {
    return renderPage(data, page);
  }
  const countRows = overviewCountRows.map((kinds) =>
    outputMessages.summary(
      kinds.map((kind) =>
        outputMessages.overviewCount(overviewKindLabels[kind], data.counts[kind]),
      ),
    ),
  );
  const columns = outputMessages.summary(
    Object.entries(data.tasks.columns).map(([column, count]) =>
      outputMessages.overviewCount(column, count),
    ),
  );
  const entries = data.items.length
    ? data.items
        .map((item) =>
          isEntity(item)
            ? renderEntitySummary(item, {
                key: outputMessages.mapKey(String(item.key), String(item.kind)),
                preserveTitleWhitespace: true,
              })
            : renderSummary(item),
        )
        .join("\n")
    : outputMessages.emptyPage;
  const lines = [
    outputMessages.overviewSummary,
    outputMessages.overviewProject(
      renderEntitySummary(data.project, { preserveTitleWhitespace: true }),
      data.generation,
    ),
    outputMessages.overviewRecords(page.total),
    ...countRows,
    outputMessages.overviewTasks(data.tasks.total, columns),
    outputMessages.overviewBlocked(data.tasks.blocked),
    "",
    outputMessages.overviewMap(page.count, page.total),
    entries,
  ];
  const continuation = renderPageContinuation(page);
  if (continuation) {
    lines.push("", continuation);
  }
  return lines.join("\n");
}
