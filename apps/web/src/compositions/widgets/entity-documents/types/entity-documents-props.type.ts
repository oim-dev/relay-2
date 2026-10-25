import type { DocumentRelation } from "@relay/contracts";
import type { DocumentSnapshot } from "domains/documents";

/**
 * Устойчивая цель материалов рабочего экрана.
 */
export interface MaterialTarget {
  /* Виды рабочих карточек, подключающих этот виджет. */
  readonly kind: Extract<DocumentRelation["target"]["kind"], "task" | "work-plan" | "release">;
  /* Постоянный ID целевой карточки текущего проекта. */
  readonly id: string;
}

/**
 * Законченный блок материалов задачи, плана либо релиза.
 */
export interface EntityDocumentsProps {
  /* Цель чтения и изменения отношений; её версия не заменяет версию документа. */
  readonly target: MaterialTarget;
}

/**
 * Выбор документа до фиксации исходной версии редактирования.
 */
export interface MaterialSelection {
  /* Прикрепление либо снятие одной пары отношений. */
  readonly action: "link" | "unlink";
  /* Постоянный ID выбранного документа; null до выбора. */
  readonly documentId: string | null;
  /* Тип выбранной связи, особенно при снятии конкретной пары. */
  readonly type: DocumentRelation["type"];
}

/**
 * Изменяемые поля формы связи, без guard или команды.
 */
export interface MaterialValues {
  /* Семантика отношения к рабочей карточке. */
  type: DocumentRelation["type"];
  /* Пояснение прикрепления; для снятия не отправляется. */
  description: string;
}

/**
 * Сохраняемый редактор одной связи, независимый от обновлений списка по SSE.
 */
export interface MaterialEditor {
  /* Исходный versioned read документа, зафиксированный до отправки. */
  readonly source: DocumentSnapshot;
  /* Пользовательское намерение, сохраняемое при закрытии диалога. */
  readonly action: MaterialSelection["action"];
  /* Сохранённые поля редактирования связи. */
  readonly values: MaterialValues;
}

/**
 * Черновик виджета живёт отдельно от списка материалов и локального открытия modal.
 */
export interface MaterialsDraft {
  /* Незавершённый выбор без отправленной команды. */
  readonly selection: MaterialSelection;
  /* Форма с исходными guards; null до явного начала редактирования. */
  readonly editor: MaterialEditor | null;
}
