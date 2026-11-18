import type { PortableEntity } from "@relay/contracts";

/**
 * Производная адресация одной immutable-ленты; исходные записи и части не изменяются.
 */
export interface ReplicationKeyTransitionContext {
  /* Замена по паре JSON [entityId, исходный ключ]. */
  readonly replacements: ReadonlyMap<string, string>;
  /* Обратная пара JSON [entityId, выбранный ключ] для точной проверки исходного no-op чтения. */
  readonly originals: ReadonlyMap<string, string>;
  /* Уже рассчитанные стороны по исходной версии; пополняется последовательно по ленте. */
  readonly records: Map<string, PortableEntity>;
}
