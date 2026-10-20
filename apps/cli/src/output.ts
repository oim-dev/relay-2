import type { EntityRecord } from "@relay/contracts";
import { stripVTControlCharacters } from "node:util";
import type { Page } from "./pagination";

export interface Result {
  data: unknown;
  meta?: Record<string, unknown> & { page?: Page };
}

const labels: Record<string, string> = {
  id: "ID",
  kind: "Тип",
  key: "Ключ",
  revision: "Ревизия",
  name: "Название",
  title: "Заголовок",
  slug: "Slug",
  summary: "Аннотация",
  description: "Описание",
  body: "Содержание",
  status: "Состояние",
  column: "Колонка",
  goal: "Цель",
  result: "Результат",
  reason: "Причина",
  createdAt: "Создано",
  updatedAt: "Изменено",
  createdBy: "Автор создания",
  updatedBy: "Автор изменения",
  completed: "Выполнено",
  canComplete: "Можно завершить",
  blockers: "Блокеры",
  items: "Записи",
  projectId: "ID проекта",
  databasePath: "База данных",
  configPath: "Конфигурация",
  generation: "Поколение",
  criteria: "Критерии",
  comments: "Комментарии",
  stages: "Этапы",
  taskIds: "Задачи",
  targets: "Цели",
  parentId: "Родитель",
  dependencies: "Зависимости",
  sections: "Разделы",
  documentSections: "Разделы документов",
  links: "Связи",
  relations: "Отношения",
  participants: "Участники",
  scope: "Область",
  outcome: "Итог",
  expectedResult: "Ожидаемый результат",
  completionConditions: "Условия завершения",
  boundaries: "Границы",
  rationale: "Обоснование",
  runId: "ID участия",
  currentRunId: "Текущее участие",
  nextStep: "Следующий шаг",
  remaining: "Осталось",
  done: "Сделано",
  checks: "Проверки",
  valid: "Проверка пройдена",
  issues: "Обнаруженные проблемы",
  total: "Всего",
  acceptanceCriteria: "Критерии приёмки",
  boardId: "ID доски",
  applicationId: "ID приложения",
  featureId: "ID фичи",
  scenarioId: "ID сценария",
  targetId: "ID цели",
  implementationIds: "ID реализаций",
  related: "Связанные задачи",
  documentKind: "Вид документа",
  documentStatus: "Состояние документа",
  sectionId: "ID раздела",
  pinned: "Закреплён",
  plan: "План",
  stage: "Этап",
  task: "Задача",
  session: "Сессия",
  checkpoint: "Контрольная точка",
  planIds: "ID планов",
  parentSessionId: "Родительская сессия",
  sessionId: "ID сессии",
  intentId: "ID намерения",
  runs: "Участия",
  operator: "Пользователь",
  children: "Дочерние поручения",
  intents: "Открытые намерения",
  references: "Ссылки",
  counts: "Счётчики",
  columns: "Колонки",
  completedAt: "Время выполнения",
  completedBy: "Автор выполнения",
  blocked: "Заблокировано",
  records: "Записей",
  bytes: "Размер в байтах",
};

export const terminalText = (value: string): string =>
  stripVTControlCharacters(value)
    .replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, "")
    .replace(/\p{Cc}/gu, (character) =>
      character === "\n" || character === "\t" ? character : "",
    );

function isEntity(value: unknown): value is EntityRecord {
  return (
    !!value && typeof value === "object" && "kind" in value && "key" in value && "data" in value
  );
}
function full(value: unknown, depth = 0): string {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "да" : "нет";
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value))
    return value.length ? value.map((entry) => `- ${full(entry, depth + 1)}`).join("\n") : "нет";
  return Object.entries(value as Record<string, unknown>)
    .map(([key, entry]) => {
      if (key === "data" && isEntity(value)) return full(entry, depth);
      const text = full(entry, depth + 1);
      return `${labels[key] ?? key}:${text.includes("\n") ? "\n" : " "}${text}`;
    })
    .join("\n");
}
function summary(value: unknown): string {
  if (isEntity(value)) {
    const name = value.data.title ?? value.data.name ?? "";
    const state = value.data.column ?? value.data.status;
    return `${value.key} · ${String(name).replace(/\s+/g, " ")} · ревизия ${value.revision}${state ? ` · ${state}` : ""}`;
  }
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    return (
      [
        item.id ?? item.name,
        item.title ?? item.name,
        item.status,
        typeof item.completed === "boolean"
          ? item.completed
            ? "выполнено"
            : "не выполнено"
          : undefined,
        item.configPath,
      ]
        .filter((part) => part !== undefined)
        .join(" · ") || full(value)
    );
  }
  return full(value);
}

export function renderResult(result: Result, format: string): string {
  if (format === "json") return JSON.stringify({ ok: true, ...result });
  const page = result.meta?.page;
  const data = result.data;
  let text: string;
  if (page && data && typeof data === "object" && "items" in data && Array.isArray(data.items)) {
    const { items, ...rest } = data as Record<string, unknown> & { items: unknown[] };
    const header = Object.keys(rest).length ? `${full(rest)}\n\n` : "";
    text = `${header}${items.length ? items.map(summary).join("\n") : "Записей нет."}\n\nПоказано ${page.count} из ${page.total}.`;
    if (page.nextCommand) text += `\nПродолжение: ${page.nextCommand}`;
  } else text = full(data);
  return terminalText(text);
}
