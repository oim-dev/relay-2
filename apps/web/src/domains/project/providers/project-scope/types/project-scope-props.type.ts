import type { ReactNode } from "react";

/** Параметры визуальной области. */
export type ProjectScopeParams = {
  /** Идентификатор выбранного проекта. */
  projectId: string;
  /** Текущий адрес проекта; не используется как идентичность данных. */
  slug?: string;
  /** Содержимое области. */
  children?: ReactNode;
};
/** Свойства проектной области без собственного DOM. */
export type ProjectScopeProps = ProjectScopeParams;
