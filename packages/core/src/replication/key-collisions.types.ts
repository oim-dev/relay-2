import type { ReplicationKeyCollision, ReplicationKeyAssignment } from "@relay/contracts";

/**
 * Выбор, однозначно связанный с новым исходным назначением ленты.
 */
export interface ResolvedReplicationKeyAssignment extends ReplicationKeyAssignment {
  /* Точный исходный ключ, разрешённый по конфликтам даже при сокращённом пользовательском вводе. */
  readonly fromKey: string;
}

/**
 * Фактическая коллизия, ещё без вычисления предложенного номера.
 */
export type ReplicationSourceKeyCollision = Omit<ReplicationKeyCollision, "suggestedKey">;

/**
 * Единый индекс адресов согласованного чтения, включая выбранные pending-назначения.
 */
export interface ReplicationKeyAddressIndex {
  /* Принятые назначения, определяющие владельца столкнувшегося ключа. */
  readonly accepted: ReadonlyMap<string, string>;
  /* Все известные владельцы адреса; коллизия local/remote не теряется при объединении. */
  readonly occupied: ReadonlyMap<string, ReadonlySet<string>>;
}
