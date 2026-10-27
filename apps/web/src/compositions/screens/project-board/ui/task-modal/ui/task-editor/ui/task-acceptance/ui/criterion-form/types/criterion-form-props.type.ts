import type { ComponentPropsWithoutRef } from "react";
import type { ChangeCriterionInput, TaskSaved } from "domains/board-tasks";
import type { AcceptanceDraft } from "../../../config/acceptance-draft.schema";

/** Параметры визуальной области. */
export type CriterionFormParams = {
  /** Исходное содержание или восстановленный черновик. */
  initialData: AcceptanceDraft;
  /** Ключ черновика в текущей вкладке. */
  draftKey: string;
  /** Последняя известная ревизия задачи. */
  currentRevision: number;
  /** Готовая задача запрещает изменение критериев. */
  isLocked: boolean;
  /** Сохранить предметную операцию. */
  onSave: (input: ChangeCriterionInput) => Promise<TaskSaved>;
  /** Закрыть после сохранения либо явной отмены. */
  onClose: () => void;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"form">, "children" | "onSubmit">;
/** Свойства визуальной области. */
export type CriterionFormProps = RootAttrs & CriterionFormParams;
