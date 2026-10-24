import {
  RelayError,
  isEntityKind,
  isPortableIdentityText,
  isPortableVersionParents,
  validateActor,
  type PortableEntity,
} from "@relay/contracts";
import { portableEntity } from "@relay/storage";
import { validateEntityData } from "../entities/entity-validation";
import { mergeObject } from "./record-merge";
import { replicationMessages } from "./replication.messages";

/**
 * Проверяет переносимую primary запись и её версию, включая lossless SQL TEXT metadata.
 * legacyRevision разрешает только прежнее диагностическое число в immutable draft source;
 * новый snapshot этого поля не принимает. Проверка не изменяет исходный payload.
 */
export function assertPortableEntity(
  value: unknown,
  legacyRevision = false,
): asserts value is PortableEntity {
  if (!mergeObject(value) || !mergeObject(value.record) || typeof value.version !== "string") {
    invalidEntity("entities");
  }
  if (Object.keys(value).some((field) => !["record", "version", "parents"].includes(field))) {
    invalidEntity("entity.fields");
  }
  const record = value.record;
  const fields = ["id", "kind", "key", "createdAt", "updatedAt", "createdBy", "updatedBy", "data"];
  if (legacyRevision) {
    fields.push("revision");
  }
  if (Object.keys(record).some((field) => !fields.includes(field))) {
    invalidEntity("record.fields");
  }
  for (const field of ["id", "key", "createdAt", "updatedAt", "createdBy", "updatedBy"]) {
    if (
      typeof record[field] !== "string" ||
      !record[field] ||
      !isPortableIdentityText(record[field])
    ) {
      invalidEntity(`record.${field}`);
    }
  }
  if (
    !isEntityKind(record.kind) ||
    !mergeObject(record.data) ||
    (legacyRevision &&
      record.revision !== undefined &&
      (!Number.isSafeInteger(record.revision) ||
        typeof record.revision !== "number" ||
        record.revision < 1))
  ) {
    invalidEntity("record");
  }
  if (record.kind === "task" && Object.hasOwn(record.data, "comments")) {
    invalidEntity("record.data.comments");
  }
  validateEntityData(record.data);
  if (value.parents !== undefined && !isPortableVersionParents(value.parents)) {
    invalidEntity("record.parents");
  }
  validateActor(record.createdBy);
  validateActor(record.updatedBy);
  if (
    !Number.isFinite(Date.parse(String(record.createdAt))) ||
    !Number.isFinite(Date.parse(String(record.updatedAt))) ||
    /[\s:\p{Cc}]/u.test(String(record.key))
  ) {
    invalidEntity("record.metadata");
  }
  // Технические поля проверены выше; предметный data проверяет typed decoder в logical snapshot.
  const entity = value as unknown as PortableEntity;
  if (portableEntity(entity.record, entity.parents).version !== entity.version) {
    invalidEntity("record.version");
  }
}

/**
 * Сохраняет точный путь отклонённого поля без lossy исправления данных.
 */
function invalidEntity(path: string): never {
  throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, { path });
}
