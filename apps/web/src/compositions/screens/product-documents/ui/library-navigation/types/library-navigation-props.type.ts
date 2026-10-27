import type { LibrarySettings } from "domains/documents";

/** Навигация общей библиотеки. */
export type LibraryNavigationProps = {
  /** Прочитанные настройки разделов. */
  settings: LibrarySettings;
  /** Выбранное представление либо section:ID. */
  selected: string;
  /** Полные счётчики проекта. */
  counts: Record<string, number>;
  /** Переход без потери поискового контекста. */
  onSelect: (value: string) => void;
};
