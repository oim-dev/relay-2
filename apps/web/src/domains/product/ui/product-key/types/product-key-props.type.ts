import type { ComponentPropsWithoutRef } from "react";

/** Параметры визуальной области. */
export type ProductKeyParams = {
  /** Читаемый ключ; отсутствие ключа не подменяется внутренним ID. */
  value?: string;
  /** Явная кнопка копирования для заголовков, без лишних действий в плотных списках. */
  copyable?: boolean;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"span">, "children">;
/** Свойства визуальной области. */
export type ProductKeyProps = RootAttrs & ProductKeyParams;
