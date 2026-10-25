import type { CommandDraft } from "domains/project";
import type {
  MaterialEditor,
  MaterialTarget,
  MaterialValues,
} from "../../../types/entity-documents-props.type";

/**
 * Поля и исход операции связи, принадлежащей виджету независимо от открытия modal.
 */
export interface DocumentLinkFormProps {
  /* Первоначальный документ и сохраняемые значения формы. */
  readonly editor: MaterialEditor;
  /* Постоянная цель прикрепления. */
  readonly target: MaterialTarget;
  /* Общий владелец frozen команды; не создаётся заново в modal. */
  readonly mutation: CommandDraft;
  /* Сохраняет изменяемые значения, не меняя guards. */
  readonly onValuesChange: (values: MaterialValues) => void;
  /* Передаёт пользовательское действие владельцу без сетевых чтений. */
  readonly onSubmit: (values: MaterialValues) => Promise<void>;
  /* Сворачивает диалог с сохранением unresolved операции. */
  readonly onClose: () => void;
  /* Отбрасывает известный черновик по явному действию. */
  readonly onDiscard: () => void;
}
