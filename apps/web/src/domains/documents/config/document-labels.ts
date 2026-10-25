import { DOCUMENT_KINDS, DOCUMENT_RELATION_TYPES, DOCUMENT_STATUSES } from "@relay/contracts";

const kindLabels = {
  specification: "Спецификация",
  description: "Описание",
  rules: "Правила",
  instruction: "Инструкция",
  proposal: "Предложение",
  decision: "Решение",
  research: "Исследование",
} as const;
const statusLabels = { draft: "Черновик", active: "Действующий", archived: "Архивный" } as const;
const relationLabels = { documents: "Документирует", references: "Ссылается на" } as const;

export const documentKindOptions = DOCUMENT_KINDS.map((value) => ({
  value,
  label: kindLabels[value],
}));
export const documentStatusOptions = DOCUMENT_STATUSES.map((value) => ({
  value,
  label: statusLabels[value],
}));
export const relationOptions = DOCUMENT_RELATION_TYPES.map((value) => ({
  value,
  label: relationLabels[value],
}));

/**
 * Представляет предметный вид документа из текущих Contracts.
 */
export function documentKindLabel(kind: keyof typeof kindLabels): string {
  return kindLabels[kind];
}

/**
 * Представляет сохраняемое состояние публикации документа.
 */
export function documentStatusLabel(status: keyof typeof statusLabels): string {
  return statusLabels[status];
}

/**
 * Представляет семантику отношения к выбранной цели.
 */
export function relationLabel(type: keyof typeof relationLabels): string {
  return relationLabels[type];
}
