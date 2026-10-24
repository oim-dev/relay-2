import type { ReplicationTransitionTargets } from "@relay/contracts";

/**
 * Обязательные цели именованной команды; технические и legacy boundaries имеют другой контракт.
 */
export interface NamedTransitionTargets extends ReplicationTransitionTargets {
  /* Ненулевой постоянный ID самостоятельного либо вложенного результата. */
  readonly primaryId: string;
  /* Адресные роли каталога и outputs; пустой объект допустим лишь без обязательных ролей. */
  readonly roles: Readonly<Record<string, string | null>>;
}
