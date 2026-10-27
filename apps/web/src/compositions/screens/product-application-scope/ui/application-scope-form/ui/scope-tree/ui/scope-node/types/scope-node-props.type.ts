import type { ComponentPropsWithoutRef } from "react";
import type { RenderTreeNodePayload } from "@mantine/core";
import type { ScopeTreeParams } from "../../../types/scope-tree-props.type";
import type { ScopeTreeEntry } from "../../../types/scope-tree-data.type";

/** Параметры узла выбора состава. */
export type ScopeNodeParams = {
  /** Содержимое выбранной ветки. */
  entry: ScopeTreeEntry;
  /** Контроллер и атрибуты дерева. */
  payload: RenderTreeNodePayload;
  /** Открыт ли редактор этого элемента. */
  isCurrent: boolean;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children" | "onToggle">;
/** Свойства визуальной области. */
export type ScopeNodeProps = RootAttrs &
  ScopeNodeParams &
  Pick<ScopeTreeParams, "onInspect" | "onToggle" | "onSelectAll">;
