import { ACTOR_LENGTH } from "./identity.constants";

/**
 * Диагностики переносимых правил идентичности автора.
 */
export const identityMessages = {
  invalidActor: `Автор: ${ACTOR_LENGTH.min}–${ACTOR_LENGTH.max} символов без краевых пробелов, управляющих символов и разделителей строк.`,
} as const;
