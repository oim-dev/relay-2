import type { ComponentPropsWithoutRef } from "react";
import type { DocumentInput } from "domains/documents";

/** Параметры визуальной области. */
export type DocumentationFormParams = {
  /** Исходное содержимое материала. */
  initial: DocumentInput;
  /** ID сохранённого документа; отсутствует при создании. */
  documentId?: string | undefined;
  /** Прочитанная ревизия документа. */
  revision: number;
  /** Изолированная область локальной восстановительной копии. */
  draftScope: string;
  /** Возврат после отмены. */
  backTo: string;
  /** Каталог вместе с фильтрами. */
  returnTo: string;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"form">, "children" | "onSubmit">;
/** Свойства визуальной области. */
export type DocumentationFormProps = RootAttrs & DocumentationFormParams;
