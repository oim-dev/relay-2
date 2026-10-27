import type { ComponentPropsWithoutRef } from "react";

/** Параметры визуальной области. */
export type ImplementationDetailsParams = {
  /** Постоянный ID реализации. */
  implementationId: string;
  /** Постоянный ID исходной фичи или сценария. */
  targetId: string;
  /** Заголовок вклада приложения. */
  title: string;
  /** Полный Markdown вклада. */
  description: string;
  /** Название приложения. */
  applicationName: string;
  /** Постоянный ID приложения для адресного чтения доски. */
  applicationId: string;
  /** Адрес приложения. */
  applicationHref: string;
  /** Адрес исходной фичи или сценария. */
  sourceHref?: string;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children">;
/** Свойства визуальной области. */
export type ImplementationDetailsProps = RootAttrs & ImplementationDetailsParams;
