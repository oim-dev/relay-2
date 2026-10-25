import type { MarkdownCheckboxProps } from "./types/markdown-checkbox-props.type";

/**
 * Обозначает состояние read-only пункта Markdown-списка для вспомогательных технологий.
 *
 * Используется для:
 *  - доступного просмотра чек-листов описания и истории
 */
export const MarkdownCheckbox = (props: MarkdownCheckboxProps) => {
  const label = props.checked ? "Пункт списка выполнен" : "Пункт списка не выполнен";
  return <input type="checkbox" disabled checked={props.checked ?? false} aria-label={label} />;
};
