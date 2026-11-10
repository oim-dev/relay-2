import type { ProjectLocation } from "./location.types";

/**
 * Выбор восстановления до чтения удалённого snapshot; SQLite не открывается и файлы не создаются.
 */
export interface ProjectRestorationContext {
  /* Физический путь выбранного либо будущего проектного конфига, с учётом workspace и symlink. */
  readonly configPath: string;
  /* Путь существующей привязки; null до получения ID нового проекта из snapshot. */
  readonly databasePath: string | null;
  /* ID прочитанного конфига; null только у нового проекта без конфига. */
  readonly projectId: string | null;
}

/**
 * Выбранная цель восстановления до материализации; фиксирует способ публикации config.
 */
export interface RestorationTarget {
  /* Путь будущей совместимой базы и конфигурации. */
  readonly location: ProjectLocation;
  /* true только если конфиг прочитан и проверен в момент выбора, а не появился позже. */
  readonly existingConfig: boolean;
}
