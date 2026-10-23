import type { WorkspaceConfig } from "../configuration/config.types";

/**
 * Результат атомарной публикации пустого workspace.
 */
export interface WorkspaceLocation {
  /* Абсолютный путь опубликованного файла workspace. */
  configPath: string;
}

/**
 * Проверенный снимок выбранного workspace вместе с адресом общего mutex.
 * Мутация должна заново прочитать конфигурацию под блокировкой физического файла.
 */
export interface WorkspaceSnapshot {
  /* Физический абсолютный путь workspace, общий для разных символьных ссылок. */
  readonly configPath: string;
  /* Полностью декодированный реестр; относительные пути разрешены от физического файла. */
  readonly config: WorkspaceConfig;
}
