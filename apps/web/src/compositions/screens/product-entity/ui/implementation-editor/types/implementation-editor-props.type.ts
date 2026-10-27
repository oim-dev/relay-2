import type { ComponentPropsWithoutRef } from "react";

/** Параметры визуальной области. */
export type ImplementationEditorParams = {
  /** Стабильная область проекта и исходная запись. */
  projectId: string;
  initial: {
    id: string;
    revision: number;
    title: string;
    description: string;
    status: "none" | "partial" | "done";
  };
  /** Перечитать подтверждённые сведения после записи. */
  onSaved: () => Promise<void>;
  /** Закрыть форму, сохранив черновик. */
  onClose: () => void;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"form">, "children" | "onSubmit">;
/** Свойства визуальной области. */
export type ImplementationEditorProps = RootAttrs & ImplementationEditorParams;
