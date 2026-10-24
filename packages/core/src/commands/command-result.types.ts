import type { BatchItemResult, EntityRecord } from "@relay/contracts";
import type { DocumentSectionIndex } from "../knowledge/document-sections.types";

/**
 * Неизменяемые данные первоначального результата до финального чтения журналов.
 */
export interface CommandResultMaterial {
  /* ID выбранного проекта для декодирования планирования. */
  readonly projectId: string;
  /* Ключ пользовательской квитанции либо null. */
  readonly operationKey: string | null;
  /* Проверочный результат не является сохранённым. */
  readonly check: boolean;
  /* Компактные результаты в момент каждого шага. */
  readonly items: readonly BatchItemResult[];
  /* Финальные карточки только затронутых владельцев. */
  readonly records: readonly EntityRecord[];
  /* ID задач только с append-эффектами, которым требуется фактическое содержание commit-снимка. */
  readonly freshTaskIds: readonly string[];
  /* Финальный индекс разделов; нужен только при наличии document в результате. */
  readonly sections: DocumentSectionIndex | undefined;
}
