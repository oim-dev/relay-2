import type { RuntimeOptions } from "@relay/project-runtime";

/**
 * Приватный foreground-контекст; explicit database не требует живого кодового checkout.
 */
export interface WorkerOptions extends RuntimeOptions {
  /* Уже подключённая физическая SQLite; отсутствие включает обычный выбор Runtime. */
  readonly databasePath?: string;
  /* Instance supervisor, переданный только владельцем долгоживущего worker. */
  readonly supervisorInstance?: string;
  /* Проверенные S binding значения защищают от подмены файла между launch и open. */
  readonly expectedProjectId?: string;
  /* Идентичность физической реплики, прочитанная перед launch. */
  readonly expectedReplicaId?: string;
}
