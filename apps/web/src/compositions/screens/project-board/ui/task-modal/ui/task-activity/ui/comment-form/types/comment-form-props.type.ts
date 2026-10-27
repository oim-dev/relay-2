import type { ComponentPropsWithoutRef } from "react";

/** Параметры визуальной области. */
export type CommentFormParams = {
  /** Проект обсуждения. */
  projectId: string;
  /** Задача обсуждения. */
  taskId: string;
  /** Обновить ленту после подтверждённой публикации. */
  onPublished: () => Promise<void>;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"form">, "children" | "onSubmit">;
/** Свойства визуальной области. */
export type CommentFormProps = RootAttrs & CommentFormParams;
