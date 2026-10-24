import type {
  CommandEffect,
  HistoryCheckpoint,
  EntityRecord,
  HistorySession,
} from "@relay/contracts";
import type { HistoryRecordMetadata } from "./history-records.types";

/**
 * Явно загруженные основания изменения истории; отсутствующие связи представлены null.
 */
export interface HistoryCommandState {
  /* Сессия-владелец исходного CAS. */
  readonly session: HistorySession;
  /* Исходное намерение для fork или продолжения материала. */
  readonly intent: HistoryCheckpoint | null;
  /* Только необходимые сессии: владелец, дети, принимаемые дети и родитель attach. */
  readonly sessions: readonly HistorySession[];
  /* Объединённые выборки материалов сессии и продолжений нужных intent. */
  readonly checkpoints: readonly HistoryCheckpoint[];
  /* Выбранные цели и проект для чистого расчёта исторических снимков. */
  readonly references: HistoryReferenceState;
}

/**
 * Явно загруженные значения для снимков ссылок, без reader и ленивого доступа к разделам.
 */
export interface HistoryReferenceState {
  /* Карточки целей в порядке ввода, без повторяющихся ID. */
  readonly records: readonly EntityRecord[];
  /* ID выбранного проекта для предметных codecs. */
  readonly projectId: string;
  /* Проект с каталогом разделов; null, если среди целей нет документов. */
  readonly project: EntityRecord | null;
}

/**
 * Выделенные до чистого расчёта метаданные новой записи либо нового run.
 */
export interface HistoryAllocation extends HistoryRecordMetadata {
  /* Проверенный свободный UUID; у перехода без создания равен null. */
  readonly id: string | null;
}

/**
 * Результат чистого расчёта с точной последовательностью эффектов.
 */
export interface HistoryCommandDelta<T extends HistorySession | HistoryCheckpoint> {
  /* Основная запись именно этого шага. */
  readonly result: T;
  /* Сессия-владелец после повышения ревизии этого шага. */
  readonly owner: HistorySession;
  /* Точные before/after; материал или ребёнок вставляется до повышения ревизии владельца. */
  readonly effects: readonly CommandEffect[];
}
