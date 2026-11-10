import { executeGitSyncRequest } from "@relay/git-sync";
import type { GitSyncClient } from "@relay/project-runtime";
import type { CliRuntime } from "./runtime.types";

/**
 * Подключает библиотечный движок к явному окружению одного CLI; внешнего sync-бинарника нет.
 * Подмена порта используется только адаптерными тестами и сохраняет исходный запрос.
 */
export function gitSyncClient(runtime: CliRuntime): GitSyncClient {
  return (
    runtime.gitSync ?? {
      /**
       * Передаёт снимок среды и отмену напрямую общему исполнителю; тот владеет Git и Core apply.
       */
      request: (request): Promise<unknown> =>
        executeGitSyncRequest(request, {
          env: runtime.env,
          ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
        }),
    }
  );
}
