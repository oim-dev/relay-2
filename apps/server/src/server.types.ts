import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { GitSyncClient, RuntimeOptions } from "@relay/project-runtime";

/**
 * Явная граница статики или встраиваемого HTTP handler; null продолжает обычный routing.
 */
export type ServerStaticHandler = (request: Request) => Response | null | Promise<Response | null>;

/**
 * Изолированные настройки одного Nest-приложения; environment читает только процессный вход.
 */
export interface RelayServerOptions {
  /* Явная область Runtime: проект либо workspace независимых баз. */
  readonly runtime: RuntimeOptions;
  /* Версия текущего выпуска. */
  readonly version: string;
  /* Начальное авторство форм; каждая mutation всё равно передаёт своего actor. */
  readonly actor: string;
  /* Процессный клиент Git Sync; отсутствие означает GIT_SYNC_UNAVAILABLE. */
  readonly gitSync?: Pick<GitSyncClient, "request">;
  /* Каталог готового Web, подключённый вызывающим приложением. */
  readonly staticHandler?: ServerStaticHandler;
  /* Необязательный handler после policy, перед обычным маршрутом. */
  readonly controlHandler?: ServerStaticHandler;
  /* Дополнительные полные origins dev frontend; отсутствие разрешает только same-origin. */
  readonly allowedOrigins?: readonly string[];
  /* Разрешённые loopback authorities с портом; отсутствие допускает любой loopback port. */
  readonly allowedHosts?: readonly string[];
  /* Интервал узкого наблюдения generation; по умолчанию 1000 мс. */
  readonly eventIntervalMs?: number;
  /* Интервал SSE heartbeat; по умолчанию 15000 мс. */
  readonly heartbeatIntervalMs?: number;
}

/**
 * Инициализированное приложение без listener, пригодное для Fastify inject.
 */
export interface RelayServerApplication {
  /* Настоящее Nest/Fastify приложение; бизнес-вызовы проходят контроллеры, pipes и guards. */
  readonly app: NestFastifyApplication;
  /* Идемпотентно прекращает SSE и новые сценарии, ожидает writers, закрывает listener. */
  readonly close: () => Promise<void>;
}

/**
 * Loopback listener; port=0 выбирает свободный порт ОС.
 */
export interface StartRelayServerOptions extends RelayServerOptions {
  /* Только 127.0.0.1, localhost или ::1; по умолчанию 127.0.0.1. */
  readonly hostname?: string;
  /* По умолчанию 3210. */
  readonly port?: number;
}

/**
 * Живой сервер с фактическим адресом listener.
 */
export interface StartedRelayServer extends RelayServerApplication {
  /* Полный origin с корневым slash для Runtime регистрации. */
  readonly url: string;
  /* Фактический TCP-порт, включая результат port=0. */
  readonly port: number;
}
