import type { ComponentPropsWithoutRef } from "react";

/** Параметры визуальной области. */
export type DocumentScopePickerParams = {
  /** Начальные ключи визуальных примеров. */
  defaultValue?: string[];
  /** Передаёт выбор владельцу формы. */
  onChange?: (ids: string[]) => void;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<
  ComponentPropsWithoutRef<"section">,
  "children" | "defaultValue" | "onChange"
>;
/** Свойства визуальной области. */
export type DocumentScopePickerProps = RootAttrs & DocumentScopePickerParams;
