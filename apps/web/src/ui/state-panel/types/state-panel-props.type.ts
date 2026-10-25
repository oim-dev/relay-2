import type { ComponentPropsWithoutRef, ReactNode } from "react";

/** Содержимое состояния страницы или панели. */
export type StatePanelParams = {
  /** Короткий заголовок. */
  title: string;
  /**
   * Уровень заголовка: h1 для самостоятельной страницы, h2 для вложенной панели.
   */
  titleAs?: "h1" | "h2";
  /** Причина состояния и следующий шаг. */
  description: string;
  /** Доступное действие. */
  action?: ReactNode;
  /** Признак первоначальной загрузки. */
  isLoading?: boolean;
};
/** Атрибуты контейнера. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "title" | "children">;
/** Свойства представления состояния. */
export type StatePanelProps = RootAttrs & StatePanelParams;
