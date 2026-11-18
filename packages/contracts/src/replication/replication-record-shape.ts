import { isEntityKind } from "../entities/identity";
import { isComponentPosition } from "../components/component-position";
import { isComponentValue } from "../components/component-shape";
import type { ComponentKind, PortableComponent } from "../components/component.types";
import type { PortableEntity } from "./replication.types";
import {
  invalidReplicationShape,
  shapeArray,
  shapeDigest,
  shapeFields,
  shapeIdentity,
  shapeInteger,
  shapeNullableIdentity,
  shapeObject,
  shapeParents,
  shapeText,
} from "./replication-shape-values";

/**
 * Проверяет переносимую форму первичной карточки без декодирования предметного data и сверки версии.
 * legacyRevision допускает прежнее диагностическое число только в immutable draft source.
 */
export function assertPortableEntityShape(
  value: unknown,
  legacyRevision = false,
): asserts value is PortableEntity {
  const entity = shapeObject(value, "entity");
  shapeFields(entity, ["record", "version"], ["parents"]);
  shapeDigest(entity.version, "entity.version");
  if (Object.hasOwn(entity, "parents")) {
    shapeParents(entity.parents);
  }
  const record = shapeObject(entity.record, "entity.record");
  shapeFields(
    record,
    ["id", "kind", "key", "createdAt", "updatedAt", "createdBy", "updatedBy", "data"],
    legacyRevision ? ["revision"] : [],
  );
  for (const field of ["id", "key", "createdAt", "updatedAt", "createdBy", "updatedBy"]) {
    shapeIdentity(record[field], `record.${field}`);
  }
  if (!isEntityKind(record.kind)) {
    invalidReplicationShape("record.kind");
  }
  shapeObject(record.data, "record.data");
  if (Object.hasOwn(record, "revision")) {
    shapeInteger(record.revision, "record.revision", 1);
  }
}

/**
 * Проверяет закрытую пару kind/value и метаданные части без digest, владельца и связности проекта.
 */
export function assertPortableComponentShape(value: unknown): asserts value is PortableComponent {
  const component = shapeObject(value, "component");
  shapeFields(component, [
    "id",
    "ownerId",
    "kind",
    "position",
    "version",
    "parents",
    "deleted",
    "value",
  ]);
  shapeIdentity(component.id, "component.id");
  shapeIdentity(component.ownerId, "component.ownerId");
  shapeDigest(component.version, "component.version");
  shapeParents(component.parents);
  if (typeof component.deleted !== "boolean" || !isComponentPosition(component.position)) {
    invalidReplicationShape("component.metadata");
  }
  // Общий value-checker возвращает false/undefined для неизвестного kind; cast не подтверждает форму.
  if (
    typeof component.kind !== "string" ||
    !isComponentValue(component.kind as ComponentKind, component.value)
  ) {
    invalidReplicationShape("component.value");
  }
}

/**
 * Проверяет форму адресов, комментариев и квитанций без интерпретации исторических JSON-строк.
 * Авторство, лимиты текста, append-only и смысл результата квитанции проверяет Core.
 */
export function assertReplicationAdditionsShape(value: Readonly<Record<string, unknown>>): void {
  for (const entry of shapeArray(value.addresses, "addresses")) {
    const address = shapeObject(entry, "address");
    shapeFields(address, ["ref", "entityId"]);
    shapeIdentity(address.ref, "address.ref");
    shapeIdentity(address.entityId, "address.entityId");
  }
  for (const entry of shapeArray(value.comments, "comments")) {
    const comment = shapeObject(entry, "comment");
    shapeFields(comment, ["taskId", "comment", "after"]);
    shapeIdentity(comment.taskId, "comment.taskId");
    shapeNullableIdentity(comment.after, "comment.after");
    const data = shapeObject(comment.comment, "comment.comment");
    shapeFields(data, ["id", "title", "body", "createdAt", "createdBy"]);
    for (const field of ["id", "createdAt", "createdBy"]) {
      shapeIdentity(data[field], `comment.${field}`);
    }
    shapeText(data.title, "comment.title");
    shapeText(data.body, "comment.body");
  }
  for (const entry of shapeArray(value.receipts, "receipts")) {
    const receipt = shapeObject(entry, "receipt");
    shapeFields(receipt, ["operationKey", "requestJson", "resultJson"]);
    for (const field of ["operationKey", "requestJson", "resultJson"]) {
      shapeIdentity(receipt[field], `receipt.${field}`);
    }
  }
}
