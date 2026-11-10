import type { ProcessResult, ProjectLocation, RuntimeOptions } from "@relay/project-runtime";

/**
 * Изолированные настоящий CLI, локальная SQLite и bare origin одного процессного сценария.
 * Соединения и процессы завершаются до возврата из callback владельцу fixture.
 */
export interface GitSyncProcessFixture {
  /* Владеющий каталог теста; удаляется целиком в finally. */
  readonly root: string;
  /* Контекст предметного проекта с отдельным RELAY_HOME. */
  readonly options: RuntimeOptions;
  /* Созданная через Runtime локальная SQLite проекта. */
  readonly location: ProjectLocation;
  /* Настоящий bare Git с пробелами, Unicode и буквальной shell-подстановкой в имени. */
  readonly remote: string;
  /* Git trace2 только процессов проверяемой CLI, без подготовительных вызовов fixture. */
  readonly tracePath: string;
  /* Один вызов скопированного бинарника; stdin и cwd задаются явно, потоки не проверяются helper. */
  readonly invoke: (
    argv: readonly string[],
    input?: string,
    cwd?: string,
  ) => Promise<ProcessResult>;
  /* Подготовка и независимые наблюдения настоящего Git; ненулевой исход немедленно отклоняется. */
  readonly git: (cwd: string, args: readonly string[]) => Promise<string>;
}
