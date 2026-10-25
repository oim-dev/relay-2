import type { UseFormReturnType } from "@mantine/form";
import type { DocumentValues } from "../../../types/document-editor.types";
/**
 * Редактор списка отношений в единственной форме документа.
 */
export interface DocumentRelationsProps {
  /* Форма владельца; собственная копия ввода не создаётся. */
  readonly form: UseFormReturnType<DocumentValues>;
  /* Запрет изменения до установления результата записи. */
  readonly disabled: boolean;
}
