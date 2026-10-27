import { join } from "node:path";
import { RelayError } from "@relay/contracts";
import { nativeDatabasePublication } from "../native/database-publication/select";
import { restorationMessages } from "./restoration.messages";
import type {
  CurrentRestorationPublication,
  RestorationTransfer,
} from "./restoration-publication.types";

/**
 * Возвращает нативный протокол для сохранения в durable intent до начала публикации.
 */
export function restorationTransfer(): RestorationTransfer {
  return nativeDatabasePublication().transfer;
}

/**
 * Выполняет только совместимый с ОС протокол проверенного v3 intent. Вызывающий удерживает
 * SQLite-lock и проверил journals/ownership; несовместимость сохраняет все файлы для recovery.
 */
export function transferRestorationDatabase(publication: CurrentRestorationPublication): void {
  const source = join(publication.staging, "project.sqlite");
  const adapter = nativeDatabasePublication();
  if (publication.transfer !== adapter.transfer) {
    throw new RelayError("RESTORE_RECOVERY_REQUIRED", restorationMessages.transferUnavailable, 4, {
      path: source,
    });
  }
  adapter.publish(source, publication.databasePath);
}
