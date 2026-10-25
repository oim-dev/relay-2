import type { Subprocess } from "bun";

/**
 * Подтверждённое ready-сообщение настоящего compiled Server.
 */
export interface ServerReady {
  /* Фактический loopback URL REST/SPA. */
  readonly url: string;
  /* UUID Runtime регистрации запуска. */
  readonly instanceId: string;
  /* UUID конкретного приобретения lifetime lease. */
  readonly bootId: string;
}

/**
 * Принадлежащий fixture дочерний процесс с постоянно читаемыми потоками.
 */
export interface ServerChild {
  /* Настоящий native executable с открытым stdin для lease-тестов. */
  readonly process: Subprocess<"pipe", "pipe", "pipe">;
  /* Подтверждённые поля stdout ready. */
  readonly ready: ServerReady;
  /* Полный stdout после выхода процесса. */
  readonly stdout: Promise<string>;
  /* Полный stderr после выхода процесса. */
  readonly stderr: Promise<string>;

  /**
   * Останавливает ready-регистрацию через authenticated Runtime control и ждёт освобождения lease.
   */
  stopGracefully(): Promise<void>;
}
