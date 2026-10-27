import type { ComponentProps, ComponentPropsWithoutRef } from "react";
import type { MarkdownField } from "ui/markdown-field";
import type { TextInput } from "@mantine/core";
import type { ProductStatus } from "domains/product-demo";

/** Контекст одного редактируемого вклада. */
export type ScopeEditorParams = {
  /** Название приложения. */
  applicationName: string;
  /** Название общей фичи или сценария. */
  title: string;
  /** Тип и родительский контекст элемента. */
  context: string;
  /** Описание общего продуктового контракта. */
  source: string;
  /** Включён ли элемент в реализацию приложения. */
  isEnabled: boolean;
  /** Ключ поля неконтролируемой формы. */
  fieldKey: string;
  /** Ключ поля заголовка вклада. */
  titleKey: string;
  /** Поле краткого заголовка для отображения в дереве. */
  titleProps: Pick<
    ComponentProps<typeof TextInput>,
    "defaultValue" | "onChange" | "onBlur" | "error"
  >;
  /** Свойства единственного поля от владельца формы. */
  fieldProps: Pick<
    ComponentProps<typeof MarkdownField>,
    "defaultValue" | "onChange" | "onBlur" | "error"
  >;
  /** Готовность собственной реализации в приложении. */
  status: ProductStatus;
  /** Включает элемент в состав. */
  onEnable: () => void;
  /** Возвращает к выбору на узком экране. */
  onBack: () => void;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children">;
/** Свойства визуальной области. */
export type ScopeEditorProps = RootAttrs & ScopeEditorParams;
