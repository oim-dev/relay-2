import { outputEntityLabels, outputLabels, outputMessages } from "../locales/output";
import type { EntityPresentation, EntitySummaryOptions, PagePresentation } from "./output.types";

/**
 * Распознаёт объект для представления; предметное декодирование остаётся ответственностью Core.
 */
export function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Отличает оболочку записи от обычного объекта по полям её содержания.
 */
export function isEntity(value: unknown): value is EntityPresentation {
  return isObject(value) && "kind" in value && "key" in value && isObject(value.data);
}

/**
 * Распознаёт состав страницы до выделения списка и дополнительных полей владельца.
 */
export function isPage(value: unknown): value is PagePresentation {
  return isObject(value) && Array.isArray(value.items);
}

/**
 * Форматирует полное значение без усечения текстов и вложенных составов.
 * Метки конкретного вида применяются только к оболочке записи и её собственному data.
 */
export function renderFullValue(
  value: unknown,
  labels: Readonly<Record<string, string>> = outputLabels,
): string {
  if (value === null) {
    return outputMessages.missing;
  }
  if (typeof value === "boolean") {
    return value ? outputMessages.yes : outputMessages.no;
  }
  if (typeof value !== "object") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.length
      ? value.map((entry) => outputMessages.listItem(renderFullValue(entry))).join("\n")
      : outputMessages.no;
  }
  const entity = isEntity(value);
  const fieldLabels = entity ? { ...labels, ...outputEntityLabels[String(value.kind)] } : labels;
  return Object.entries(value)
    .map(([key, entry]) => {
      if (key === "data" && entity) {
        return renderFullValue(entry, fieldLabels);
      }
      return outputMessages.field(fieldLabels[key] ?? key, renderFullValue(entry));
    })
    .join("\n");
}

/**
 * Показывает адрес, название, ревизию и состояние; снятое участие отмечает независимо от статуса.
 * Переопределение адреса нужно карте, добавляющей вид сущности к ключу.
 */
export function renderEntitySummary(
  value: EntityPresentation,
  options: EntitySummaryOptions = {},
): string {
  const name = String(value.data.title ?? value.data.name ?? "");
  const state = value.data.column ?? value.data.status;
  const summary = outputMessages.entity(
    options.key ?? String(value.key),
    options.preserveTitleWhitespace ? name : name.replace(/\s+/g, " "),
    String(value.revision),
    state ? String(state) : undefined,
  );
  return value.kind === "implementation" && value.data.active === false
    ? outputMessages.summary([summary, outputMessages.inactiveImplementation])
    : summary;
}

/**
 * Форматирует запись обычного списка; неизвестную форму показывает полностью.
 */
export function renderSummary(value: unknown): string {
  if (isEntity(value)) {
    return renderEntitySummary(value);
  }
  if (isObject(value)) {
    let completion: string | undefined;
    if (typeof value.completed === "boolean") {
      completion = value.completed ? outputMessages.completed : outputMessages.unfinished;
    }
    const parts = [
      value.id ?? value.name,
      value.title ?? value.name,
      value.status,
      completion,
      value.path ?? value.configPath,
    ].filter((part) => part !== undefined);
    return outputMessages.summary(parts) || renderFullValue(value);
  }
  return renderFullValue(value);
}
