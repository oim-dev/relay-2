import type { ReactNode } from "react";

/** Параметры визуальной области. */
export type ReleasePlanPickerProps = {
  /** Полный набор выбранных ID. */
  selectedIds: string[];
  /** Изменение полного выбора. */
  onChange: (ids: string[]) => void;
  /** Ошибка поля состава. */
  error?: ReactNode;
};
