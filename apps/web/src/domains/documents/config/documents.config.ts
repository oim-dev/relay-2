import type { DocumentInput } from "../types/document.type";

/** Названия типов, одинаковые при чтении, создании и поиске. */
export const DOCUMENT_KINDS = {
  description: "Описание",
  specification: "Техническое задание",
  rules: "Правила",
  instruction: "Инструкция",
  proposal: "Проект решения",
  decision: "Решение",
  research: "Исследование",
};
/** Варианты назначения документа. */
export const DOCUMENT_KIND_OPTIONS: { value: DocumentInput["documentKind"]; label: string }[] = [
  { value: "description", label: DOCUMENT_KINDS.description },
  { value: "specification", label: DOCUMENT_KINDS.specification },
  { value: "rules", label: DOCUMENT_KINDS.rules },
  { value: "instruction", label: DOCUMENT_KINDS.instruction },
  { value: "proposal", label: DOCUMENT_KINDS.proposal },
  { value: "decision", label: DOCUMENT_KINDS.decision },
  { value: "research", label: DOCUMENT_KINDS.research },
];
/** Состояние документа, не состояние локального ввода. */
export const DOCUMENT_STATUSES = { draft: "Черновик", active: "Действующий", archived: "Архив" };
/** Варианты состояния публикации. */
export const DOCUMENT_STATUS_OPTIONS = Object.entries(DOCUMENT_STATUSES).map(([value, label]) => ({
  value,
  label,
}));
