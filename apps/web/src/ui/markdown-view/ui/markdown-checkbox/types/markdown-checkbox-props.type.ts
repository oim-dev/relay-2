import type { ComponentPropsWithoutRef } from "react";

/**
 * Состояние пункта от Markdown-renderer; React допускает явный undefined
 * для ещё не отмеченного checkbox, наравне с отсутствующим свойством.
 */
export type MarkdownCheckboxProps = Pick<ComponentPropsWithoutRef<"input">, "checked">;
