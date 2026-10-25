import type { ProjectDatabase } from "@relay/storage";
import type { ProjectLocation, RuntimeOptions } from "@relay/project-runtime";
import type { RelayClient } from "@relay/rest-sdk";
import type { StartedRelayServer } from "../../src/server.types";

/**
 * Изолированный реальный Nest listener и проект одной проверки.
 */
export interface ServerFixture {
  /* Собственный каталог сценария в .artifacts. */
  readonly directory: string;
  /* Явная область без глобальной смены cwd/env. */
  readonly runtime: RuntimeOptions;
  /* Созданная отдельная проектная SQLite. */
  readonly location: ProjectLocation;
  /* Настоящий Nest/Fastify port0 listener. */
  readonly server: StartedRelayServer;
  /* Штатный браузерный REST SDK. */
  readonly client: RelayClient;
  /* Соединение принадлежит helper и закрывается после Promise action. */
  readonly database: <T>(action: (db: ProjectDatabase) => T | Promise<T>) => Promise<T>;
}
