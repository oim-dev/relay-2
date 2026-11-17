import type { Subprocess } from "bun";
import type { ServerReady } from "../process/process-fixture.types";

/**
 * Копия исходников Server, не имеющая соседнего Web dist и принадлежащая одному тесту.
 */
export interface DevelopmentSource {
  /* Уникальный корень fixture; удаляется после завершения её процессов. */
  readonly directory: string;
  /* Копия Server с исходниками, OpenAPI, package.json, tsconfig и ссылкой на зависимости. */
  readonly serverDirectory: string;
}

/**
 * Настоящий Bun watch с непрерывным чтением потоков и очередью ready каждого boot.
 */
export interface DevelopmentServer {
  /* Процесс watcher; открытый stdin удерживает parent lease. */
  readonly child: Subprocess<"pipe", "pipe", "pipe">;
  /* Полный stderr, доступный после завершения процесса. */
  readonly stderr: Promise<string>;

  /**
   * Ожидает следующее проверенное ready-событие с deadline, не подставляя старый boot.
   */
  nextReady(): Promise<ServerReady>;

  /**
   * Страховочно убивает ещё живой watcher и дожидается обоих потоков.
   * Тест проверяет штатный exit до вызова этой очистки.
   */
  dispose(): Promise<void>;
}
