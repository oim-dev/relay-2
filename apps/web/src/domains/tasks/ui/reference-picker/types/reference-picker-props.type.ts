import type { EntityKind } from "@relay/contracts";
import type { ReactNode } from "react";

/**
 * Выбор существующей записи по ID из продолжаемого списка.
 */
export interface ReferencePickerProps {
  /* Вид допустимых вариантов; предметную допустимость проверяет Core. */
  readonly kind: EntityKind;
  /* Доступная подпись поля. */
  readonly label: string;
  /* Исходный выбранный ID, включая вариант вне первой страницы. */
  readonly defaultValue?: string;
  /* Возвращает ID либо пустую строку при очистке. */
  readonly onChange?: (id: string) => void;
  /* Обработчик проверки поля. */
  readonly onBlur?: () => void;
  /* Ошибка поля формы. */
  readonly error?: ReactNode;
  /* Блокировка при записи или неизвестном исходе. */
  readonly disabled?: boolean;
}
