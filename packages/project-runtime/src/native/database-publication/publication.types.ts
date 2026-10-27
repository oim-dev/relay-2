import type { RestorationTransfer } from "../../project/restoration-publication.types";

/**
 * Нативная публикация private SQLite под удерживаемым вызывающим SQLite-барьером.
 * Не заменяет существующее назначение. Пути на одной ФС; journals и владение проверены Runtime.
 */
export interface DatabasePublication {
  /* Способ, сохраняемый в durable intent; несовместимый intent отвергается до изменения файлов. */
  readonly transfer: RestorationTransfer;
  /**
   * Публикует datafile без изменения inode/File ID; hardlink сохраняет private alias для cleanup.
   */
  publish(source: string, destination: string): void;
}
