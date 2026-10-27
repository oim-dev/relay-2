import { linkSync } from "node:fs";
import type { DatabasePublication } from "./publication.types";

/**
 * Windows SQLite-handle запрещает rename. Hardlink публикует тот же File ID;
 * private alias удерживается до отдельной cleanup с native sharing-защитой живых клиентов.
 */
export const windowsDatabasePublication: DatabasePublication = {
  transfer: "hardlink",
  /**
   * Создаёт только отсутствующее публичное имя; существующий файл никогда не заменяется.
   */
  publish(source, destination): void {
    linkSync(source, destination);
  },
};
