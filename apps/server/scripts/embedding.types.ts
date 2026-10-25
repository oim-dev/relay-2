import type { BunPlugin } from "bun";

/**
 * Результат подготовки file imports всего готового Web dist.
 */
export interface WebEmbedding {
  /* Детерминированный список публичных asset URL. */
  readonly urls: readonly string[];
  /* Plugin заменяет только source loader Server. */
  readonly plugin: BunPlugin;
  /* Подтверждает фактическое подключение embedding в завершённой сборке. */
  readonly used: () => boolean;
}
