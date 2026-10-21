import type { DocumentSection } from "@relay/contracts";
import type { DOCUMENT_SECTION_ACTIONS } from "./knowledge-constants";

/**
 * Индекс разделов одного проверенного снимка проекта.
 */
export interface DocumentSectionIndex {
  /* ID активных разделов; порядок для проверки принадлежности несущественен. */
  readonly active: ReadonlySet<string>;
  /* Навсегда зарезервированные ID снятых разделов. */
  readonly retired: ReadonlySet<string>;
}

/**
 * Поддерживаемые операции над разделами проекта.
 */
export type DocumentSectionAction = (typeof DOCUMENT_SECTION_ACTIONS)[number];

/**
 * Проверенное изменение одного раздела; null в before означает конец списка.
 */
export type DocumentSectionChange =
  | {
      /* Создание либо изменение названия. */
      readonly action: "create" | "update";
      /* Проверенный ID раздела; при создании может быть сгенерирован. */
      readonly id: string;
      /* Непустое однострочное название. */
      readonly name: string;
    }
  | {
      /* Перемещение существующего раздела. */
      readonly action: "move";
      /* ID перемещаемого раздела. */
      readonly id: string;
      /* ID следующего раздела либо null для переноса в конец. */
      readonly before: string | null;
    }
  | {
      /* Снятие раздела с пожизненным резервированием ID. */
      readonly action: "remove";
      /* ID снимаемого раздела. */
      readonly id: string;
    };

/**
 * Рассчитанный состав разделов; документные ссылки при снятии не переписываются.
 */
export interface DocumentSectionState {
  /* Активные разделы в пользовательском порядке. */
  readonly documentSections: DocumentSection[];
  /* Все снятые ID, включая снятый текущей операцией. */
  readonly retiredDocumentSectionIds: string[];
}
