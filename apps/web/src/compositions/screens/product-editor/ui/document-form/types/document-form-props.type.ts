import type { ComponentPropsWithoutRef } from "react";
import type { ProductDocumentInput } from "domains/product-demo";

/** Контекст редактирования. */
export type DocumentFormParams = {
  /** Подтверждённый документ. */
  initial: ProductDocumentInput;
  /** Исходная версия снимка. */
  revision: number;
  /** Ключ области черновика. */
  draftScope: string;
  /** Возврат при отмене. */
  backTo: string;
};
/** Атрибуты формы. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"form">, "children" | "onSubmit">;
/** Свойства редактора. */
export type DocumentFormProps = RootAttrs & DocumentFormParams;
