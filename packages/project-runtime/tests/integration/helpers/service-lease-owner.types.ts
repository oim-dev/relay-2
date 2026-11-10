import type { Subprocess } from "bun";

/**
 * Отдельный владелец lifetime mutex; RuntimeFixture завершает процесс до очистки его каталога.
 */
export interface ServiceLeaseOwner {
  /* EOF stdin освобождает lease; fixture дополнительно владеет deadline и принудительным завершением. */
  readonly child: Subprocess<"pipe", "pipe", "pipe">;
  /* Stderr читается параллельно с ожиданием ready и завершением процесса. */
  readonly errors: Promise<string>;
}
