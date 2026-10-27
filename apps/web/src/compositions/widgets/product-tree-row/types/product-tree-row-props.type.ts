import type { ComponentPropsWithoutRef } from "react";
import type { RenderTreeNodePayload } from "@mantine/core";
import type { ProductStatus } from "domains/product-demo";

/** Общая проекция строки двухуровневого дерева продукта. */
export type ProductTreeRowParams = {
  /** Исходное название фичи или сценария. */
  name: string;
  /** Читаемый ключ отображаемой сущности. */
  entityKey?: string;
  /** Смысл фичи либо заголовок вклада приложения. */
  summary?: string;
  /** Переход по названию. */
  href: string;
  /** Состояние узла в текущем контексте. */
  status: ProductStatus;
  /** Подпись для неопределённого состава сценариев. */
  readinessLabel?: string;
  /** Подпись прогресса справа. */
  countLabel?: string;
  /** Родительская строка фичи. */
  isFeature: boolean;
  /** Завершает вертикальную ветку. */
  isLastScenario?: boolean;
  /** Контроллер и атрибуты Mantine Tree. */
  payload: RenderTreeNodePayload;
  /** Отдельный переход к исходному продуктовому описанию. */
  sourceHref?: string;
  /** Доступное название ссылки на исходное описание. */
  sourceLabel?: string;
  /** Адрес возврата после открытия редактора или источника. */
  returnTo?: string;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children">;
/** Свойства визуальной области. */
export type ProductTreeRowProps = RootAttrs & ProductTreeRowParams;
