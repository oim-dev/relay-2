import type { ComponentPropsWithoutRef, ReactNode } from "react";

/** Параметры страницы продукта. */
export type ProductPageParams = {
  /** Заголовок. */
  title: string;
  /** Краткий смысл. */
  description: string;
  /** Контекст заголовка. */
  eyebrow?: string;
  /** Адрес возврата. */
  backTo?: string;
  /** Контекст страницы просмотра при возврате из редактора. */
  backState?: unknown;
  /** Подпись возврата. */
  backLabel?: string;
  /** Основные действия. */
  actions?: ReactNode;
  /** Готовность и текущая работа. */
  meta?: ReactNode;
  /** Содержимое страницы. */
  children?: ReactNode;
};
/** Атрибуты области страницы. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"section">, "children" | "title">;
/** Свойства страницы. */
export type ProductPageProps = RootAttrs & ProductPageParams;
