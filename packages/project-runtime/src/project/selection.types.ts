import type { ProjectConfig } from "../configuration/config.types";

/**
 * Внутренний выбор проверенной конфигурации до открытия базы и сверки её постоянного ID.
 */
export interface SelectedProjectConfig {
  /* Абсолютный путь выбранного проектного файла с сохранением явной символьной ссылки. */
  readonly configPath: string;
  /* Проверенный формат; относительный databasePath уже разрешён от физического каталога файла. */
  readonly config: ProjectConfig;
}
