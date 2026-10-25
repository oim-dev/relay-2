import type { Subprocess } from "bun";

/**
 * Дочерний изолированный сервер; caller владеет остановкой и потоками до удаления fixture.
 */
export interface ServerTestProcess {
  /* Собственный handle ребёнка, используемый для crash-инъекции и cleanup. */
  readonly child: Subprocess<"pipe", "pipe", "pipe">;
  /* Конкурентное чтение stderr предотвращает зависание заполненного pipe. */
  readonly stderr: Promise<string>;
  /* Уборка собственного процесса и drain обоих потоков, включая отказ assertion. */
  readonly close: () => Promise<void>;
}
