import { dirname } from "node:path";
import { hasProjectGit, synchronizationDueAt } from "@relay/project-runtime";
import type { Invocation } from "./invocation";
import { gitSyncClient } from "./git-sync-client";
import { describeCliFailure } from "../errors/errors";
import { terminalText } from "../output/terminal";
import { synchronizationMessages as messages } from "../locales/synchronization";

/**
 * Перед предметным snapshot подхватывает созревший обмен; ошибка сети не отменяет локальную команду.
 * Дешёвая проверка SQLite не запускает компонент до срока; транспорт повторяет её под своим mutex.
 */
export async function synchronizeInvocation(invocation: Invocation): Promise<void> {
  if (
    !hasProjectGit(dirname(invocation.location.configPath)) ||
    Date.now() < synchronizationDueAt(invocation.db.getSynchronizationSchedule())
  ) {
    return;
  }
  try {
    await gitSyncClient(invocation.runtime).request({
      version: 1,
      action: "auto",
      options: invocation.options,
    });
  } catch (error) {
    if (invocation.runtime.signal?.aborted) {
      throw error;
    }
    const failure = describeCliFailure(error);
    const warning =
      invocation.text("format") === "json"
        ? JSON.stringify({
            type: "git-sync",
            level: "warning",
            error: { code: failure.code, message: failure.message },
          })
        : messages.deferred(failure.code, terminalText(failure.message));
    invocation.runtime.stderr?.(`${warning}\n`);
  }
}
