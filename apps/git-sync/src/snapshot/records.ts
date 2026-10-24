import {
  isEntityKind,
  type PortableEntity,
  type PortableAddress,
  type PortableComment,
  type PortableBatchReceipt,
} from "@relay/contracts";
import { array, invalidSnapshot, keys, object, text } from "./json";

/**
 * Проверяет переносимую форму карточки; предметное содержимое data проверяет только Core.
 */
export function entity(value: unknown): PortableEntity {
  const wrapper = object(value);
  keys(
    wrapper,
    wrapper.parents === undefined ? ["record", "version"] : ["record", "version", "parents"],
  );
  const record = object(wrapper.record);
  keys(record, ["id", "kind", "key", "createdAt", "updatedAt", "createdBy", "updatedBy", "data"]);
  if (!isEntityKind(record.kind)) {
    return invalidSnapshot();
  }
  const version = text(wrapper.version);
  if (!/^[a-f0-9]{64}$/.test(version)) {
    return invalidSnapshot();
  }
  return {
    version,
    ...(wrapper.parents === undefined ? {} : { parents: array(wrapper.parents).map(digest) }),
    record: {
      id: text(record.id),
      kind: record.kind,
      key: text(record.key),
      createdAt: text(record.createdAt),
      updatedAt: text(record.updatedAt),
      createdBy: text(record.createdBy),
      updatedBy: text(record.updatedBy),
      data: object(record.data),
    },
  };
}

/**
 * Проверяет форму адреса; уникальность и принадлежность владельцу определяет Core.
 */
export function address(value: unknown): PortableAddress {
  const item = object(value);
  keys(item, ["ref", "entityId"]);
  return { ref: text(item.ref), entityId: text(item.entityId) };
}

/**
 * Проверяет закрытую форму независимого append-only комментария.
 */
export function comment(value: unknown): PortableComment {
  const item = object(value);
  keys(item, ["taskId", "comment", "after"]);
  const record = object(item.comment);
  keys(record, ["id", "title", "body", "createdAt", "createdBy"]);
  return {
    taskId: text(item.taskId),
    after: item.after === null ? null : text(item.after),
    comment: {
      id: text(record.id),
      title: text(record.title),
      body: text(record.body),
      createdAt: text(record.createdAt),
      createdBy: text(record.createdBy),
    },
  };
}

/**
 * Проверяет форму исторической пользовательской квитанции без повторного исполнения запроса.
 */
export function receipt(value: unknown): PortableBatchReceipt {
  const item = object(value);
  keys(item, ["operationKey", "requestJson", "resultJson"]);
  return {
    operationKey: text(item.operationKey),
    requestJson: text(item.requestJson),
    resultJson: text(item.resultJson),
  };
}

/**
 * Проверяет переносимый SHA-256 без попытки вывести предметную идентичность из времени.
 */
function digest(value: unknown): string {
  const result = text(value);
  if (!/^[a-f0-9]{64}$/.test(result)) {
    return invalidSnapshot();
  }
  return result;
}
