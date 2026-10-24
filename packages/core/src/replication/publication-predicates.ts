import type {
  PortableProjectSnapshot,
  ReplicationPredicate,
  ReplicationTransition,
} from "@relay/contracts";
import { snapshotRecords } from "./snapshot-records";

/**
 * Вычисляет реальные положительные/отрицательные выборки согласованного контекста до перехода.
 * Полный снимок уже загружен сценарием репликации; предметные правила используют тот же состав.
 */
export function effectivePredicates(
  snapshot: PortableProjectSnapshot,
  predicates: ReplicationTransition["predicates"],
): ReplicationPredicate[] {
  const records = snapshotRecords(snapshot);
  const addresses = new Map(snapshot.addresses.map((entry) => [entry.ref, entry.entityId]));
  const versions = new Map(snapshot.entities.map((entry) => [entry.record.id, entry.version]));
  return (predicates ?? []).map(({ selector }) => {
    let selected = records;
    let present: boolean | null = null;
    switch (selector.kind) {
      case "entity":
        selected = records.filter(
          (entry) =>
            entry.id === (addresses.get(selector.ref) ?? selector.ref) &&
            (selector.entityKind === undefined || entry.kind === selector.entityKind),
        );
        break;
      case "records":
        selected = records.filter(
          (entry) =>
            selector.ids.includes(entry.id) &&
            (selector.entityKind === undefined || entry.kind === selector.entityKind),
        );
        break;
      case "identities":
        selected = records.filter((entry) =>
          selector.refs.some((ref) => (addresses.get(ref) ?? ref) === entry.id),
        );
        break;
      case "kind":
        selected = records.filter((entry) => entry.kind === selector.entityKind);
        break;
      case "field":
        selected = records.filter(
          (entry) =>
            entry.kind === selector.entityKind && entry.data[selector.field] === selector.value,
        );
        break;
      case "field-set":
        selected = records.filter(
          (entry) =>
            entry.kind === selector.entityKind &&
            typeof entry.data[selector.field] === "string" &&
            selector.values.includes(String(entry.data[selector.field])),
        );
        break;
      case "task-graph":
        selected = records.filter((entry) => entry.kind === "task");
        break;
      case "memberships":
        selected = records.filter(
          (entry) =>
            entry.kind === "work-plan" &&
            Array.isArray(entry.data.stages) &&
            entry.data.stages.some(
              (stage: unknown) =>
                stage !== null &&
                typeof stage === "object" &&
                "taskIds" in stage &&
                Array.isArray(stage.taskIds) &&
                stage.taskIds.includes(selector.taskId),
            ),
        );
        break;
      case "virtual":
        selected = records.filter(
          (entry) =>
            entry.kind === selector.entityKind &&
            (entry.data.slug === selector.ref || entry.data.prefix === selector.ref),
        );
        break;
      case "array-item":
        selected = records.filter(
          (entry) =>
            entry.kind === selector.entityKind &&
            Array.isArray(entry.data[selector.arrayField]) &&
            (entry.data[selector.arrayField] as unknown[]).some(
              (item) =>
                item !== null &&
                typeof item === "object" &&
                selector.itemField in item &&
                Reflect.get(item, selector.itemField) === selector.value,
            ),
        );
        present = selected.length > 0;
        break;
      case "address-state":
        selected = records.filter((entry) => entry.id === addresses.get(selector.ref));
        present = selected.length > 0;
        break;
      case "receipt":
        selected = [];
        present = snapshot.receipts.some((entry) => entry.operationKey === selector.operationKey);
        break;
    }
    return {
      selector,
      present,
      records: selected
        .map((record) => ({
          id: record.id,
          version:
            selector.kind === "identities" ||
            selector.kind === "virtual" ||
            (selector.kind === "entity" && selector.semantic === "existence")
              ? null
              : (versions.get(record.id) ?? null),
        }))
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
    };
  });
}
