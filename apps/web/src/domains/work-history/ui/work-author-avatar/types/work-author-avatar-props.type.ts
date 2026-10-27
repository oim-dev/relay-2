import type { ComponentPropsWithoutRef } from "react";
import type { HistoryOperator as WorkOperator } from "@relay/contracts";

/** Параметры визуальной области. */
export type WorkAuthorAvatarParams = {
  /** Человек из авторского run конкретной точки, не latestRun ветки. */
  operator: WorkOperator | null;
  /** Геометрия маркера в пикселях. */
  size?: number;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"span">, "children">;
/** Свойства визуальной области. */
export type WorkAuthorAvatarProps = RootAttrs & WorkAuthorAvatarParams;
