import type { GitSyncResponse } from "@relay/contracts";
import type { RuntimeOptions, ProjectLocation } from "@relay/project-runtime";

/**
 * Процессный fixture с настоящим бинарником, bare remote и изолированными home.
 */
export interface ProcessFixture {
  /* Каталог теста под .artifacts. */
  readonly root: string;
  /* Общий стандартный Git remote теста. */
  readonly remote: string;
  /* Путь именно собранного компонентного бинарника. */
  readonly binary: string;
  /* Создаёт независимый контекст и при необходимости локальный проект. */
  context(
    name: string,
    initialize?: boolean,
  ): { options: RuntimeOptions; location: ProjectLocation | null };
  /* Запускает один request и проверяет единый stdout JSON, stderr и согласованность exit. */
  request(
    options: RuntimeOptions,
    action: string,
    input?: Record<string, unknown>,
    env?: Record<string, string>,
  ): Promise<GitSyncResponse>;
}
