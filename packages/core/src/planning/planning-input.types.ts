import type { PlanningFilter } from "@relay/contracts";

/**
 * Ограничения строкового поля на границе ввода или декодирования хранения.
 */
export interface PlanningTextRules {
  /* Максимальная длина в UTF-16; без настройки применяется общий предел полного текста. */
  readonly maxLength?: number;
  /* Запрещает пустую строку и пробельный текст; по умолчанию пустое значение допустимо. */
  readonly required?: boolean;
  /* Запрещает переводы строк; по умолчанию разрешён многострочный текст. */
  readonly singleLine?: boolean;
}

/**
 * Проверенный фильтр, постепенно собираемый на внешней границе.
 */
export type ParsedPlanningFilter = {
  -readonly [Field in keyof PlanningFilter]: PlanningFilter[Field];
};
