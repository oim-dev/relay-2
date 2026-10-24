import { randomUUID } from "node:crypto";
import { lstatSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RelayError } from "@relay/contracts";
import type { SupervisorFailureCause, SupervisorFailureRecord } from "./supervisor-failure.types";

const MAX_FAILURE_RECORDS = 16;
const MAX_FAILURE_CAUSES = 6;
const MAX_FAILURE_RECORD_BYTES = 8 * 1024;

/**
 * Выделяет только bounded machine codes, не копируя message/stack/details даже из вложенных причин.
 * Цикл cause прекращает обход; неизвестное значение не становится строковым dump.
 */
function failureCauses(error: unknown): SupervisorFailureCause[] {
  const causes: SupervisorFailureCause[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (
    current &&
    typeof current === "object" &&
    !seen.has(current) &&
    causes.length < MAX_FAILURE_CAUSES
  ) {
    seen.add(current);
    const code = "code" in current ? current.code : undefined;
    const exitCode = current instanceof RelayError ? current.exitCode : undefined;
    const errno = "errno" in current ? current.errno : undefined;
    const win32Code = "win32Code" in current ? current.win32Code : undefined;
    causes.push({
      code: typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code) ? code : null,
      exitCode: typeof exitCode === "number" && Number.isSafeInteger(exitCode) ? exitCode : null,
      errno: typeof errno === "number" && Number.isSafeInteger(errno) ? errno : null,
      win32Code:
        typeof win32Code === "number" && Number.isSafeInteger(win32Code) ? win32Code : null,
    });
    current = "cause" in current ? current.cause : undefined;
  }
  return causes;
}

/**
 * Дополняет stderr нового supervisor безопасной записью fatal-исхода в его физическом home.
 * Caller уже создал/канонизировал home; writer не создаёт чужие каталоги и отвергает symlink git-sync.
 * Первые 16 записей сохраняются в эксклюзивных слотах 00…15, без замены/удаления прежних файлов.
 * Каждая запись ограничена 8 KiB; тексты ошибок и произвольные данные не сериализуются.
 * Заполненный namespace или ошибка записи не скрывают и не заменяют первичную ошибку supervise.
 */
export function recordSupervisorFailure(home: string, error: unknown): void {
  try {
    const directory = join(home, "git-sync");
    const entry = lstatSync(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      return;
    }
    const record: SupervisorFailureRecord = {
      version: 1,
      kind: "supervisor-failure",
      attemptId: randomUUID(),
      pid: process.pid,
      observedAt: new Date().toISOString(),
      causes: failureCauses(error),
    };
    const text = JSON.stringify(record, null, 2) + "\n";
    if (Buffer.byteLength(text, "utf8") > MAX_FAILURE_RECORD_BYTES) {
      return;
    }
    for (let slot = 0; slot < MAX_FAILURE_RECORDS; slot++) {
      const path = join(directory, `supervisor-failure-${String(slot).padStart(2, "0")}.json`);
      try {
        writeFileSync(path, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
        return;
      } catch (cause) {
        if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "EEXIST") {
          return;
        }
      }
    }
  } catch {
    // Диагностика не имеет права менять error/exit code, уже предназначенные stderr вызывающего.
  }
}
