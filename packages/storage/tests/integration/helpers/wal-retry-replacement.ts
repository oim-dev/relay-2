import { spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { WalRetryEvent, WalRetryProbeResult } from "./concurrent-open.types";

/**
 * Перемещает закрытую SQLite-семью между принадлежащими тесту свободными именами.
 * Старые файлы сохраняются в отдельном каталоге fixture, не перезаписывая новую БД.
 */
function moveClosedFamily(source: string, destination: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(`${source}${suffix}`)) {
      renameSync(`${source}${suffix}`, `${destination}${suffix}`);
    }
  }
}

/**
 * Однократно внедряет SQLITE_BUSY на первом WAL-переходе обычного open. Все остальные query/close
 * настоящие. Только после native close первого handle подменяет закрытый owned-файл подготовленной
 * replacement-семьёй. Обе БД заранее должны быть закрыты и приведены к DELETE тестом.
 * Callback синхронен; spies снимаются в finally. Возможная аварийная уборка оставшихся handle
 * выполняется после снятия spies и не может выдать себя за наблюдённое закрытие/retry production.
 */
export function withWalBusyReplacement<T>(
  path: string,
  replacement: string,
  operation: () => T,
): WalRetryProbeResult<T> {
  path = resolve(path);
  const nativeQuery = Database.prototype.query;
  const nativeClose = Database.prototype.close;
  const connections = new Set<Database>();
  const closed = new Set<Database>();
  const reopened = new Set<Database>();
  const firstAttempt = new Set<Database>();
  let replaced = false;
  const events: WalRetryEvent[] = [];
  const trace = {
    walAttempts: 0,
    busyFailures: 0,
    firstCloses: 0,
    closedHandleRejectsQuery: false,
    reopens: 0,
    retryCloses: 0,
    events,
  };

  /**
   * Делегирует generic query исходному Bun Statement без преобразования его результата.
   * Assertion сохраняет generic-сигнатуру API; подменяется только однократный отказ WAL-перехода.
   */
  const observeQuery = function (this: Database, sql: string): ReturnType<Database["query"]> {
    if (this.filename === path) {
      connections.add(this);
      if (replaced && !firstAttempt.has(this) && !reopened.has(this)) {
        reopened.add(this);
        trace.reopens += 1;
        events.push("reopened");
      }
      if (/^\s*PRAGMA\s+journal_mode\s*=\s*WAL\s*;?\s*$/iu.test(sql)) {
        trace.walAttempts += 1;
        if (firstAttempt.size === 0) {
          firstAttempt.add(this);
          trace.busyFailures += 1;
          events.push("wal-busy");
          throw Object.assign(new Error("fixture: однократный WAL BUSY"), { code: "SQLITE_BUSY" });
        }
        events.push("wal-retry");
      }
    }
    return nativeQuery.call(this, sql);
  } as Database["query"];
  /**
   * Сначала закрывает настоящее соединение, затем переносит подготовленную fixture; повторные close не подменяют её снова.
   */
  const observeClose = function (this: Database, throwOnError?: boolean): void {
    nativeClose.call(this, throwOnError);
    closed.add(this);
    if (firstAttempt.has(this)) {
      trace.firstCloses += 1;
      events.push("first-closed");
      if (!replaced) {
        try {
          nativeQuery.call(this, "SELECT 1").get();
        } catch {
          trace.closedHandleRejectsQuery = true;
        }
        if (!trace.closedHandleRejectsQuery) {
          throw new Error("Fixture нельзя подменять до действительного закрытия первого handle");
        }
        const retired = mkdtempSync(join(dirname(path), "retired-open-"));
        moveClosedFamily(path, join(retired, "project.sqlite"));
        moveClosedFamily(replacement, path);
        replaced = true;
        events.push("fixture-replaced");
      }
    } else if (reopened.has(this)) {
      trace.retryCloses += 1;
      events.push("retry-closed");
    }
  };
  const queryHook = spyOn(Database.prototype, "query").mockImplementation(observeQuery);
  const closeHook = spyOn(Database.prototype, "close").mockImplementation(observeClose);
  try {
    return { value: operation(), trace };
  } finally {
    closeHook.mockRestore();
    queryHook.mockRestore();
    for (const connection of connections) {
      if (!closed.has(connection)) {
        nativeClose.call(connection, true);
      }
    }
  }
}
