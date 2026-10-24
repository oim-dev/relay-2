import {
  assembleComponentRecord,
  type EntityRecord,
  type PortableEntity,
  type PortableProjectSnapshot,
} from "@relay/contracts";

/**
 * Собирает сохранённые raw aggregates для чистых предметных декодеров.
 * revision=1 — внутренняя форма декодера, не импортируемый CAS и не историческая ревизия.
 */
export function snapshotRecords(snapshot: PortableProjectSnapshot): EntityRecord[] {
  return snapshot.entities.map((entry) => logicalRecord(entry, snapshot));
}

/**
 * Восстанавливает только первичные компоненты данного владельца без UI effective-проекций.
 */
export function logicalRecord(
  entry: PortableEntity,
  snapshot: PortableProjectSnapshot,
): EntityRecord {
  const record = { ...entry.record, revision: 1 };
  return snapshot.modelVersion === 2
    ? assembleComponentRecord(record, snapshot.components ?? [])
    : record;
}
