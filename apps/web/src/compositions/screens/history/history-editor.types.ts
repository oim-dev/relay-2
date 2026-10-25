import type { HistoryCheckpoint, HistoryCheckpointAction } from "@relay/contracts";
import type { HistorySource, SessionAction } from "domains/history";
/**
 * Экранный выбор хранится в scope проекта и переживает закрытие Modal и переход по маршруту.
 */
export interface HistoryEditorState {
  /* Исходное действие с исходной сессией, run и intent. */
  readonly editor: HistoryEditor;
  /* Показывается диалог; false оставляет форму владельцем восстановления. */
  readonly opened: boolean;
}
/**
 * Зафиксированный выбор редактора сессии; SSE не меняет его владельца или намерение.
 */
export type HistoryEditor =
  | {
      /* Выбирает форму жизненного цикла сессии. */
      readonly kind: "session";
      /* Явное действие пользователя. */
      readonly action: SessionAction;
      /* Полный исходный снимок владельца CAS и переносимой версии. */
      readonly source: HistorySource;
      /* Намерение для fork; отсутствует у остальных переходов. */
      readonly intent?: HistoryCheckpoint;
    }
  | {
      /* Выбирает форму нового неизменяемого материала. */
      readonly kind: "checkpoint";
      /* Явный вид записи материала. */
      readonly action: HistoryCheckpointAction;
      /* Исходная сессия, чья ревизия защищает append-only запись. */
      readonly source: HistorySource;
      /* Исходное намерение; отсутствует только для открытия нового. */
      readonly intent?: HistoryCheckpoint;
    };
