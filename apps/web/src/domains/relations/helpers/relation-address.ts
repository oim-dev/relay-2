import type { EntityRef } from "../types/relations.type";

/**
 * Канонический адрес визуального узла по постоянному ID.
 */
export const relationAddress = (ref: EntityRef): string => `${ref.kind}:${ref.id}`;
