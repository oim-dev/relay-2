import type { RenderTreeNodePayload } from "@mantine/core";
import type { ApplicationTreeEntry } from "../../../types/application-tree.type";

/** Параметры узла приложения для общего продуктового дерева. */
export type ApplicationFeatureProps = ApplicationTreeEntry & {
  /** Приложение, которому принадлежит редактируемый вклад. */
  applicationId: string;
  /** Контроллер и атрибуты дерева. */
  payload: RenderTreeNodePayload;
};
