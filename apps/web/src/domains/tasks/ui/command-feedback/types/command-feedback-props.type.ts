import type { CommandDraft } from "domains/project";

/**
 * Диагностика сохранённой операции без собственных действий записи.
 */
export interface CommandFeedbackProps {
  /* Состояние команды ближайшей формы. */
  readonly action: CommandDraft;
}
