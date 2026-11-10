import type { GitSyncResponse } from "@relay/contracts";
import type { RuntimeOptions, ProjectLocation, ProcessResult } from "@relay/project-runtime";

/**
 * Процессный fixture с настоящим бинарником, bare remote и изолированными home.
 */
export interface ProcessFixture {
  /* Каталог теста под .artifacts. */
  readonly root: string;
  /* Общий стандартный Git remote теста. */
  readonly remote: string;
  /* Путь собранного relay с библиотекой Git Sync и private guardian-ролями. */
  readonly binary: string;
  /* Создаёт независимый контекст и при необходимости локальный проект. */
  context(name: string, initialize?: boolean): ProcessProjectContext;
  /* Запускает один request и проверяет единый stdout JSON, stderr и согласованность exit. */
  request(
    options: RuntimeOptions,
    action: string,
    input?: Record<string, unknown>,
    env?: Record<string, string>,
  ): Promise<GitSyncResponse>;
}

/**
 * Независимая локальная область одного участника процессной проверки.
 */
export interface ProcessProjectContext {
  /* Явные cwd и home участника без изменения окружения runner. */
  readonly options: RuntimeOptions;
  /* Созданная локальная БД; null оставляет пустой каталог для restore. */
  readonly location: ProjectLocation | null;
}

/**
 * Одноразовый процесс CLI с одновременно читаемыми потоками и конечным deadline.
 * Владелец ожидает outcome и завершает child в finally, если сценарий прервался раньше.
 */
export interface StartedSyncRequest {
  /* Собственный CLI-процесс теста; kill адресует его, а не сохранённый PID чужого owner. */
  readonly child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  /* Полные ограниченные потоки и exit code, без декодирования или сокрытия аварийного выхода. */
  readonly outcome: Promise<ProcessResult>;
}
