import {
  BATCH_LIMITS,
  BATCH_NESTED_RESULT_KINDS,
  RelayError,
  isEntityKind,
  type BatchIdentity,
  type BatchItemResult,
  type BatchOutput,
  type BatchResult,
  type BatchResultKind,
  type BatchRevisionOwner,
  type EntityRecord,
  type ProjectEntity,
} from "@relay/contracts";
import { decodeKnowledge } from "../knowledge/knowledge-data";
import { decodePlanning } from "../planning/planning-data";
import { decodeHistoryCheckpoint, decodeHistorySession } from "../history/history-data";
import { taskRecord } from "../tasks/task-data";
import { batchFields, batchObject, batchText } from "./batch-input";
import { batchMessages } from "./batch.messages";

const identityFields = ["id", "kind", "key", "revision"] as const;

/**
 * Отказывает повреждённой форме квитанции; её данные никогда не заменяются текущими карточками.
 */
function corruptReceipt(): never {
  throw new RelayError("CORRUPT_DATA", batchMessages.corruptReceipt);
}

/**
 * Проверяет положительную ревизию в сохранённом результате без поддержки входных маркеров.
 */
function receiptRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    corruptReceipt();
  }
  return value;
}

/**
 * Проверяет вид основного либо вложенного результата.
 */
function receiptKind(value: unknown): BatchResultKind {
  if (isEntityKind(value)) {
    return value;
  }
  return BATCH_NESTED_RESULT_KINDS.find((kind) => kind === value) ?? corruptReceipt();
}

/**
 * Декодирует компактную идентичность с явным null только у вложенного результата.
 */
function receiptIdentity(value: unknown): BatchIdentity {
  const fields = batchObject(value, "receipt.identity");
  const kind = receiptKind(fields.kind);
  const key = fields.key === null ? null : batchText(fields.key, "receipt.key");
  if (isEntityKind(kind) === (key === null)) {
    corruptReceipt();
  }
  return {
    id: batchText(fields.id, "receipt.id"),
    kind,
    key,
    revision: receiptRevision(fields.revision),
  };
}

/**
 * Декодирует владельца CAS, который всегда является самостоятельной сущностью.
 */
function receiptOwner(value: unknown): BatchRevisionOwner {
  batchFields(value, identityFields, "receipt.owner");
  const identity = receiptIdentity(value);
  if (!isEntityKind(identity.kind) || identity.key === null) {
    corruptReceipt();
  }
  return { ...identity, kind: identity.kind, key: identity.key };
}

/**
 * Декодирует дополнительный именованный выход без полного содержания.
 */
function receiptOutput(value: unknown): BatchOutput {
  const fields = batchFields(value, ["name", ...identityFields], "receipt.output");
  return { ...receiptIdentity(fields), name: batchText(fields.name, "receipt.output.name") };
}

/**
 * Проверяет квитанцию шага и её положение в исходном массиве.
 */
function receiptItem(value: unknown, index: number): BatchItemResult {
  const fields = batchFields(
    value,
    ["index", "op", "as", "owner", "outputs", ...identityFields],
    "receipt.item",
  );
  if (fields.index !== index || !Array.isArray(fields.outputs)) {
    corruptReceipt();
  }
  return {
    ...receiptIdentity(fields),
    index,
    op: batchText(fields.op, "receipt.op"),
    as: fields.as === null ? null : batchText(fields.as, "receipt.as"),
    owner: receiptOwner(fields.owner),
    outputs: fields.outputs.map(receiptOutput),
  };
}

/**
 * Проверяет сохранённую историческую карточку через декодер её владельца без чтения текущей БД.
 * Раздел документа остаётся первоначальным: последующие удаления не изменяют квитанцию.
 */
function receiptEntity(value: unknown, projectId: string): ProjectEntity {
  const fields = batchFields(
    value,
    [...identityFields, "createdAt", "createdBy", "updatedAt", "updatedBy", "data"],
    "receipt.entity",
  );
  const identity = receiptOwner(
    Object.fromEntries(identityFields.map((field) => [field, fields[field]])),
  );
  const record: EntityRecord = {
    ...identity,
    createdAt: batchText(fields.createdAt, "receipt.createdAt"),
    createdBy: batchText(fields.createdBy, "receipt.createdBy"),
    updatedAt: batchText(fields.updatedAt, "receipt.updatedAt"),
    updatedBy: batchText(fields.updatedBy, "receipt.updatedBy"),
    data: { ...batchObject(fields.data, "receipt.data") },
  };
  switch (record.kind) {
    case "task":
      return taskRecord(record);
    case "work-plan":
    case "release":
      return decodePlanning(record, projectId);
    case "work-session":
      return decodeHistorySession(record);
    case "work-checkpoint":
      return decodeHistoryCheckpoint(record);
    default:
      return decodeKnowledge(record, record.kind);
  }
}

/**
 * Проверяет полноту исторического состава относительно основных выходов, владельцев и зависимых записей.
 * Ключ и ревизия могут измениться следующими шагами пакета, но ID/вид неизменны, а ревизия не убывает.
 * Вложенные результаты не требуют самостоятельной карточки: их агрегат указан в owner.
 */
function validateReceiptEntities(
  items: readonly BatchItemResult[],
  entities: readonly ProjectEntity[],
): void {
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  if (byId.size !== entities.length) {
    corruptReceipt();
  }
  for (const identity of items.flatMap((item) => [item, item.owner, ...item.outputs])) {
    if (!isEntityKind(identity.kind)) {
      continue;
    }
    const entity = byId.get(identity.id);
    if (!entity || entity.kind !== identity.kind || entity.revision < identity.revision) {
      corruptReceipt();
    }
  }
}

/**
 * Восстанавливает первоначальный результат после reopen; повреждение даёт CORRUPT_DATA с причиной.
 * Только replayed меняется при восстановлении; адреса, CAS и текущие сущности не читаются.
 * Неожиданные ошибки декодеров пробрасываются без объявления корректной квитанции повреждённой.
 */
export function decodeBatchReceipt(
  json: string,
  operationKey: string,
  projectId: string,
): BatchResult {
  try {
    const fields = batchFields(
      JSON.parse(json),
      ["operationKey", "status", "replayed", "items", "entities"],
      "receipt",
    );
    if (
      fields.operationKey !== operationKey ||
      fields.status !== "committed" ||
      fields.replayed !== false ||
      !Array.isArray(fields.items) ||
      fields.items.length < 1 ||
      fields.items.length > BATCH_LIMITS.operations ||
      !Array.isArray(fields.entities)
    ) {
      corruptReceipt();
    }
    const entities = fields.entities.map((entity) => receiptEntity(entity, projectId));
    const items = fields.items.map(receiptItem);
    validateReceiptEntities(items, entities);
    return {
      operationKey,
      status: "committed",
      replayed: true,
      items,
      entities,
    };
  } catch (error) {
    if (
      !(error instanceof SyntaxError) &&
      (!(error instanceof RelayError) ||
        !["INVALID_ARGUMENT", "INVALID_INPUT", "VALIDATION_ERROR", "CORRUPT_DATA"].includes(
          error.code,
        ))
    ) {
      throw error;
    }
    const failure = new RelayError("CORRUPT_DATA", batchMessages.corruptReceipt, 1, {
      operationKey,
    });
    failure.cause = error;
    throw failure;
  }
}
