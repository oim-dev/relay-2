import type { TaskCriterion } from "@relay/contracts";

/**
 * Представление критерия без владения командой или её восстановлением.
 */
export interface CriterionRowProps {
  /* Прочитанный критерий; обновление строки не меняет сохранённую команду владельца. */
  readonly criterion: TaskCriterion;
  /* Блокировка действий во время редактирования или выяснения исхода команды. */
  readonly disabled: boolean;
  /* Запрашивает изменение отметки через владельца сценария. */
  readonly onToggle: () => void;
  /* Открывает редактор текстов у владельца. */
  readonly onEdit: () => void;
  /* Запрашивает снятие критерия; frozen command остаётся вне этой строки. */
  readonly onRemove: () => void;
}
