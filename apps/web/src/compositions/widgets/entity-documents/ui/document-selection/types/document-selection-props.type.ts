import type { DocumentSnapshot } from "domains/documents";
import type { MaterialSelection } from "../../../types/entity-documents-props.type";

/**
 * Подготовка исходного чтения перед открытием полей связи.
 */
export interface DocumentSelectionProps {
  /* Выбранный адрес и намерение пользователя. */
  readonly selection: MaterialSelection;
  /* Сохраняет выбор без отправки команды. */
  readonly onSelect: (id: string | null) => void;
  /* Фиксирует прочитанную версию до начала редактирования. */
  readonly onPrepare: (source: DocumentSnapshot) => void;
  /* Отбрасывает предварительный выбор без начатой записи. */
  readonly onDiscard: () => void;
}
