import type { Subprocess } from "bun";

/**
 * Отдельный реальный владелец SQLite и loopback health; процесс принадлежит RuntimeFixture.
 */
export interface SupervisorLockOwner {
  /* EOF stdin завершает owner; fixture дополнительно завершает его при отказе теста. */
  readonly child: Subprocess<"pipe", "pipe", "pipe">;
  /* Диагностика читается параллельно и должна оставаться пустой при штатном завершении. */
  readonly errors: Promise<string>;
}
