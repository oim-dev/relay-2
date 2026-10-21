import type { EntityIdentity, EntityRecord } from "@relay/contracts";

/**
 * Две технические доски с пересечением slug/prefix и сохранённым алиасом первой доски.
 */
export interface AddressedBoards {
  /* Начальная карточка первой доски; key после подготовки служит алиасом. */
  readonly first: EntityRecord;
  /* Карточка второй доски, чей prefix совпадает со slug первой. */
  readonly second: EntityRecord;
  /* Текущая идентичность переименованной первой доски. */
  readonly identity: EntityIdentity;
}
