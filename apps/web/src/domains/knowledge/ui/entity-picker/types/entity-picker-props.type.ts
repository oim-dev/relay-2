import type { EntityKind } from "@relay/contracts";
import type { GetInputPropsReturnType } from "@mantine/form";

/**
 * Выбор постоянного ID из ограниченно загружаемого каталога.
 */
export interface EntityPickerProps {
  /* Вид каталога, разрешённый полем команды. */
  readonly kind: EntityKind;
  /* Видимое название поля. */
  readonly label: string;
  /* Выбранный постоянный ID; null означает незаполненное поле. */
  readonly value: string | null;
  /* Сохраняет только постоянный ID выбранной карточки. */
  readonly onChange: (id: string | null) => void;
  /* Предметные ограничения списка. */
  readonly filters?: Record<string, string>;
  /* Запрет изменения на время неопределённой записи. */
  readonly disabled?: boolean;
  /* Метаданные поля Mantine для ошибки, blur и фокуса; выбор остаётся controlled. */
  readonly field?: GetInputPropsReturnType;
}
