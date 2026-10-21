import type { ENTITY_KINDS } from "./identity.constants";

/**
 * Вид локальной сущности, выведенный из единого перечня ENTITY_KINDS.
 */
export type EntityKind = (typeof ENTITY_KINDS)[number];
