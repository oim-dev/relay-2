import type { GitSyncClient } from "@relay/project-runtime";

/**
 * Подменяет только одноразовый процессный порт; БД, выбор проекта и Core остаются настоящими.
 * Не создаёт процессов и ресурсов.
 */
export function requestClient(request: GitSyncClient["request"]): GitSyncClient {
  return { request };
}
