import {
  RelayError,
  isEntityKind,
  type EntityIdentity,
  type EntityKind,
  type EntityRecord,
} from "@relay/contracts";
import type { ProjectDatabase } from "@relay/storage";
import { entityMessages } from "./entity.messages";
import type { EntityReference } from "./entity.types";
import { validateEntityAddress } from "./entity-validation";

/**
 * Выделяет явный вид ссылки до поиска буквального ключа, исключая неоднозначный синтаксис.
 * Несовпадение явного и ожидаемого вида отклоняется как INVALID_ARGUMENT.
 */
function parseEntityReference(ref: string, kind?: EntityKind): EntityReference {
  validateEntityAddress(ref, "ref");
  const colon = ref.indexOf(":");
  if (colon === -1) {
    return { ref, kind };
  }
  const explicitKind = ref.slice(0, colon);
  const address = ref.slice(colon + 1);
  if (!isEntityKind(explicitKind) || !address.trim() || address.includes(":")) {
    throw new RelayError("INVALID_ARGUMENT", entityMessages.typedReference, 2);
  }
  if (kind !== undefined && kind !== explicitKind) {
    throw new RelayError("INVALID_ARGUMENT", entityMessages.expectedReferenceKind(kind), 2);
  }
  validateEntityAddress(address, "ref");
  return { ref: address, kind: explicitKind };
}

/**
 * Определяет виды, у которых slug и prefix участвуют в адресации вместе с ключами.
 */
function hasVirtualAddresses(kind: EntityKind | undefined): kind is "board" | "application" {
  return kind === "board" || kind === "application";
}

/**
 * Разрешает ссылку без загрузки содержания в уже удерживаемом снимке или транзакции.
 * ID, ключ и алиас имеют приоритет перед slug/prefix ожидаемого вида.
 * Отсутствие цели даёт NOT_FOUND, неоднозначность виртуального адреса — CORRUPT_DATA.
 */
export function resolveEntityIdentity(
  db: ProjectDatabase,
  input: string,
  expectedKind?: EntityKind,
): EntityIdentity {
  const { ref, kind } = parseEntityReference(input, expectedKind);
  const entity = db.getIdentity(ref, kind);
  if (entity) {
    return entity;
  }
  if (hasVirtualAddresses(kind)) {
    const virtual = db.findAddressIdentities(ref, kind);
    if (virtual.length > 1) {
      throw new RelayError("CORRUPT_DATA", entityMessages.ambiguousAddress, 1, { ref, kind });
    }
    if (virtual[0]) {
      return virtual[0];
    }
  }
  throw new RelayError("NOT_FOUND", entityMessages.recordNotFound, 3, { ref, kind });
}

/**
 * Выделяет ключ в транзакции записи, пропуская занятые виртуальные адреса того же вида.
 * Явный ключ возвращается без расходования счётчика; его занятость проверяется перед insert.
 * Изменения счётчика откатываются вместе с создаваемой сущностью при отказе операции.
 */
export function allocateEntityKey(
  db: ProjectDatabase,
  kind: EntityKind,
  prefix: string,
  key?: string,
): string {
  if (key !== undefined) {
    return key;
  }
  let allocatedKey = db.nextKey(prefix);
  if (hasVirtualAddresses(kind)) {
    const reserved = new Set(
      db.list(kind).flatMap((entity) => [entity.data.slug, entity.data.prefix]),
    );
    while (reserved.has(allocatedKey)) {
      allocatedKey = db.nextKey(prefix);
    }
  }
  return allocatedKey;
}

/**
 * Проверяет адреса создаваемой или переименовываемой доски/приложения под общей транзакцией.
 * Ключи, алиасы и виртуальные адреса одного вида не могут переходить к другой записи.
 * Один список вида используется для всех проверок кандидата; конфликт даёт CONFLICT.
 */
export function validateEntityAddresses(db: ProjectDatabase, entity: Readonly<EntityRecord>): void {
  if (!hasVirtualAddresses(entity.kind)) {
    return;
  }
  const others = db.list(entity.kind).filter((record) => record.id !== entity.id);
  // Проверяем оба направления: новый ключ и новые slug/prefix при создании.
  for (const address of [entity.key, entity.data.slug, entity.data.prefix]) {
    if (typeof address !== "string" || !address) {
      continue;
    }
    const stored = db.getIdentity(address, entity.kind);
    if (
      (stored && stored.id !== entity.id) ||
      others.some((record) => record.data.slug === address || record.data.prefix === address)
    ) {
      throw new RelayError("CONFLICT", entityMessages.occupiedAddress(address), 4, {
        kind: entity.kind,
        ref: address,
      });
    }
  }
}
