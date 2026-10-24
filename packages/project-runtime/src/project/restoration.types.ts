import type { ProjectLocation } from "./location.types";

/**
 * Выбранная цель восстановления до материализации; фиксирует способ публикации config.
 */
export interface RestorationTarget {
  /* Путь будущей совместимой базы и конфигурации. */
  readonly location: ProjectLocation;
  /* true только если конфиг прочитан и проверен в момент выбора, а не появился позже. */
  readonly existingConfig: boolean;
}
