import type { ComponentPropsWithoutRef } from "react";
import type { ActivitySummary } from "domains/board-tasks";

/** Параметры визуальной области. */
export type DiscussionMessageParams = {
  /** Выбранный проект. */
  projectId: string;
  /** Постоянный ID задачи. */
  taskId: string;
  /** Метаданные сообщения. */
  entry: ActivitySummary;
  /** Открыт ли таб. */
  active: boolean;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"article">, "children" | "aria-labelledby">;
/** Свойства визуальной области. */
export type DiscussionMessageProps = RootAttrs & DiscussionMessageParams;
