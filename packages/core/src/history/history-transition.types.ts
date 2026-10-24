import type { HistoryCheckpoint, HistorySession } from "@relay/contracts";

/**
 * Декодированные основания одного перехода истории без I/O и локального CAS.
 * Массивы содержат полный относящийся к шагу состав: материалы сессии и intent
 * выбираются независимо, дети — объединением обеих обратных связей.
 * after содержит состояние непосредственно после шага, а не итог всего пакета.
 */
export interface HistoryTransitionContext {
  /* Заранее выделенный ID нового run для start/attach/resume/takeover; не выводится из эффекта named-команды. */
  readonly newRunId?: string;
  /* Дословный автор предметного шага. */
  readonly actor: string;
  /* Имя действия session.* либо checkpoint.* из общего каталога. */
  readonly operation: string;
  /* Сессии и связанные владельцы до шага, включая выбранных детей. */
  readonly beforeSessions: readonly HistorySession[];
  /* Те же сессии с эффектами этого шага, включая созданного ребёнка. */
  readonly afterSessions: readonly HistorySession[];
  /* Материалы до шага, включая независимую выборку продолжений intent. */
  readonly beforeCheckpoints: readonly HistoryCheckpoint[];
  /* Материалы после шага, включая единственный добавленный checkpoint. */
  readonly afterCheckpoints: readonly HistoryCheckpoint[];
}
