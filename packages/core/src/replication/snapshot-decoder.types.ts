import type { PortableProjectSnapshot } from "@relay/contracts";

declare const decodedSnapshot: unique symbol;

/**
 * Номинальная immutable форма: runtime authority проверяется private WeakMap, а не наличием свойства.
 */
export interface DecodedReplicationSnapshot extends PortableProjectSnapshot {
  /* Недоступная caller типовая метка проверенного дерева. */
  readonly [decodedSnapshot]: true;
}

/**
 * Проверенная immutable копия JSON; ограниченный кеш не хранит данные SQL или пользовательские CAS.
 */
export interface DecodedSnapshotCacheEntry {
  /* Полностью замороженное каноническое дерево. */
  readonly snapshot: PortableProjectSnapshot;
  /* Размер JSON в UTF-8 для ограничения retained данных процесса. */
  readonly bytes: number;
}
