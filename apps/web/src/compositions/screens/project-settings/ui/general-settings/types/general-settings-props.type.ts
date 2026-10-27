import type { ComponentPropsWithoutRef } from "react";
import type { ProjectSettings } from "domains/project";

/** Параметры визуальной области. */
export type GeneralSettingsParams = {
  /** Последняя подтверждённая сервером версия настроек. */
  settings: ProjectSettings;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"section">, "children" | "id">;
/** Свойства визуальной области. */
export type GeneralSettingsProps = RootAttrs & GeneralSettingsParams;
