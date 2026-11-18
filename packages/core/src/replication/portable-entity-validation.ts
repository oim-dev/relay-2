import {
  RelayError,
  assertPortableEntityShape,
  validateActor,
  type PortableEntity,
} from "@relay/contracts";
import { portableEntity } from "@relay/storage";
import { validateEntityData } from "../entities/entity-validation";
import { replicationMessages } from "./replication.messages";

/**
 * После общего shape decoder проверяет переносимую primary запись и её содержательную версию.
 * legacyRevision разрешает только прежнее диагностическое число в immutable draft source;
 * новый snapshot этого поля не принимает. Проверка не изменяет исходный payload.
 */
export function assertPortableEntity(
  value: unknown,
  legacyRevision = false,
): asserts value is PortableEntity {
  assertPortableEntityShape(value, legacyRevision);
  const record = value.record;
  for (const field of ["id", "key", "createdAt", "updatedAt", "createdBy", "updatedBy"] as const) {
    if (!record[field]) {
      invalidEntity(`record.${field}`);
    }
  }
  if (record.kind === "task" && Object.hasOwn(record.data, "comments")) {
    invalidEntity("record.data.comments");
  }
  validateEntityData(record.data);
  validateActor(record.createdBy);
  validateActor(record.updatedBy);
  if (
    !Number.isFinite(Date.parse(String(record.createdAt))) ||
    !Number.isFinite(Date.parse(String(record.updatedAt))) ||
    /[\s:\p{Cc}]/u.test(String(record.key))
  ) {
    invalidEntity("record.metadata");
  }
  if (portableEntity(value.record, value.parents).version !== value.version) {
    invalidEntity("record.version");
  }
}

/**
 * Сохраняет точный путь отклонённого поля без lossy исправления данных.
 */
function invalidEntity(path: string): never {
  throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, { path });
}
