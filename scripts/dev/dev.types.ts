import type { RuntimeOptions } from "@relay/project-runtime";

/**
 * Проверенные настройки одной dev-сессии; пути абсолютны и не зависят от cwd дочерних процессов.
 */
export interface DevelopmentOptions {
  /* Выбранный внешний проект/workspace и его существующий Relay home. */
  readonly runtime: RuntimeOptions;
  /* Автор Web; отсутствие сохраняет стандартный выбор Server. */
  readonly actor?: string;
  /* Фиксированный loopback-порт API, 1–65535. */
  readonly port: number;
  /* Фиксированный loopback-порт Vite, отличный от API. */
  readonly webPort: number;
}

/**
 * Явная среда orchestration; stdin и процессы принадлежат одной терминальной сессии.
 */
export interface DevelopmentEnvironment {
  /* Корень checkout, содержащего исходники и package scripts. */
  readonly repository: string;
  /* Bun, которым запущен dispatcher. */
  readonly bun: string;
  /* Снимок окружения терминала; дочерние процессы получают явные Relay overrides. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /* Отмена по SIGINT/SIGTERM терминала. */
  readonly signal: AbortSignal;
}
