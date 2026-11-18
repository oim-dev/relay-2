import { isEntityKind } from "../entities/identity";
import {
  invalidReplicationShape,
  shapeArray,
  shapeFields,
  shapeIdentity,
  shapeNullableDigest,
  shapeObject,
} from "./replication-shape-values";

/**
 * Проверяет закрытую форму переносимых предикатов; набор совпадений и смысл селектора проверяет Core.
 */
export function assertReplicationPredicatesShape(value: unknown): void {
  for (const entry of shapeArray(value, "predicates")) {
    const predicate = shapeObject(entry, "predicate");
    shapeFields(predicate, ["selector", "records", "present"]);
    assertSelectorShape(predicate.selector);
    if (predicate.present !== null && typeof predicate.present !== "boolean") {
      invalidReplicationShape("predicate.present");
    }
    for (const entry of shapeArray(predicate.records, "predicate.records")) {
      const record = shapeObject(entry, "predicate.record");
      shapeFields(record, ["id", "version"]);
      shapeIdentity(record.id, "predicate.record.id");
      shapeNullableDigest(record.version, "predicate.record.version");
    }
  }
}

/**
 * Проверяет варианты ReplicationPredicate.selector; локальные key/summaries не являются wire-формой.
 */
function assertSelectorShape(value: unknown): void {
  const selector = shapeObject(value, "selector");
  switch (selector.kind) {
    case "entity":
      shapeFields(selector, ["kind", "ref"], ["entityKind", "semantic"]);
      if (
        Object.hasOwn(selector, "semantic") &&
        selector.semantic !== "content" &&
        selector.semantic !== "existence"
      ) {
        invalidReplicationShape("selector.semantic");
      }
      break;
    case "identities":
      shapeFields(selector, ["kind", "refs"]);
      break;
    case "records":
      shapeFields(selector, ["kind", "ids"], ["entityKind"]);
      break;
    case "virtual":
      shapeFields(selector, ["kind", "ref", "entityKind"]);
      break;
    case "field":
      shapeFields(selector, ["kind", "entityKind", "field", "value"]);
      break;
    case "field-set":
      shapeFields(selector, ["kind", "entityKind", "field", "values"]);
      break;
    case "kind":
      shapeFields(selector, ["kind", "entityKind"]);
      break;
    case "array-item":
      shapeFields(selector, ["kind", "entityKind", "arrayField", "itemField", "value"]);
      break;
    case "task-graph":
      shapeFields(selector, ["kind"]);
      break;
    case "memberships":
      shapeFields(selector, ["kind", "taskId"]);
      break;
    case "address-state":
      shapeFields(selector, ["kind", "ref"]);
      break;
    case "receipt":
      shapeFields(selector, ["kind", "operationKey"]);
      break;
    default:
      invalidReplicationShape("selector.kind");
  }
  for (const [field, item] of Object.entries(selector)) {
    if (field === "entityKind") {
      if (!isEntityKind(item)) {
        invalidReplicationShape("selector.entityKind");
      }
    } else if (field === "refs" || field === "ids" || field === "values") {
      for (const entry of shapeArray(item, `selector.${field}`)) {
        shapeIdentity(entry, `selector.${field}`);
      }
    } else {
      shapeIdentity(item, `selector.${field}`);
    }
  }
}
