import {
  RelayError,
  type EntityIdentity,
  type EntityReadItem,
  type EntityReadOptions,
  type EntityReadResult,
  type EntitySummary,
  type ProjectEntity,
} from "@relay/contracts";
import type { ProjectDatabase } from "@relay/storage";
import { resolveEntityIdentity } from "../entities/entity-addresses";
import { entityMessages } from "../entities/entity.messages";
import { validateEntityAddress } from "../entities/entity-validation";
import { EntityReader } from "../projections/entity-reader";
import { decodeEntitySummary } from "../projections/entity-summary";

/**
 * Сохраняет известный отказ одного адреса; ошибки соединения и неожиданные исключения пробрасывает.
 * Список кодов ограничен разрешением адреса и декодированием выбранного содержания.
 */
function readAddressItem<T>(ref: string, read: () => T): EntityReadItem<T> {
  try {
    return { ref, ok: true, entity: read() };
  } catch (error) {
    if (
      !(error instanceof RelayError) ||
      !["INVALID_ARGUMENT", "VALIDATION_ERROR", "NOT_FOUND", "CORRUPT_DATA"].includes(error.code)
    ) {
      throw error;
    }
    return {
      ref,
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        exitCode: error.exitCode,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
  }
}

/**
 * Разрешает обычные адреса одним пакетом через entity_refs, без полного содержания.
 * Типизированные ссылки передаются общему resolver, включая slug/prefix досок и приложений.
 * Повторный адрес использует результат текущего снимка; ошибки сохраняют позиции аргументов.
 */
function resolveReadAddresses(
  db: ProjectDatabase,
  refs: readonly string[],
): EntityReadItem<EntityIdentity>[] {
  const ordinary = [...new Set(refs.filter((ref) => !ref.includes(":")))];
  const identities = db.resolveMany(ordinary);
  const direct = new Map(ordinary.map((ref, index) => [ref, identities[index]]));
  const resolved = new Map<string, EntityReadItem<EntityIdentity>>();
  return refs.map((ref) => {
    const cached = resolved.get(ref);
    if (cached) {
      return cached;
    }
    const item = readAddressItem(ref, () => {
      if (ref.includes(":")) {
        return resolveEntityIdentity(db, ref);
      }
      validateEntityAddress(ref, "ref");
      const identity = direct.get(ref);
      if (!identity) {
        throw new RelayError("NOT_FOUND", entityMessages.recordNotFound, 3, { ref });
      }
      return identity;
    });
    resolved.set(ref, item);
    return item;
  });
}

/**
 * Выбирает уникальные постоянные ID успешных адресов, исключая повторную загрузку алиасов.
 */
function selectedIds(addresses: readonly EntityReadItem<EntityIdentity>[]): string[] {
  return [...new Set(addresses.flatMap((item) => (item.ok ? [item.entity.id] : [])))];
}

/**
 * Декодирует каждую найденную сущность один раз и восстанавливает исходные адреса и повторы.
 * Исчезновение уже разрешённого ID в одном снимке считается CORRUPT_DATA, а не пропуском.
 */
function assembleReadItems<Stored, Entity>(
  addresses: readonly EntityReadItem<EntityIdentity>[],
  records: ReadonlyMap<string, Stored>,
  decode: (record: Stored) => Entity,
): EntityReadItem<Entity>[] {
  const decoded = new Map<string, EntityReadItem<Entity>>();
  return addresses.map((address) => {
    if (!address.ok) {
      return address;
    }
    const id = address.entity.id;
    let item = decoded.get(id);
    if (!item) {
      item = readAddressItem(address.ref, () => {
        const record = records.get(id);
        if (record === undefined) {
          throw new RelayError("CORRUPT_DATA", entityMessages.missingResolvedRecord, 1, { id });
        }
        return decode(record);
      });
      decoded.set(id, item);
    }
    return { ...item, ref: address.ref };
  });
}

/**
 * Загружает выбранные полные записи одним пакетом; для документов добавляет только паспорт проекта.
 * Reader разделяется всеми записями, поэтому каталог разделов строится один раз на снимок.
 */
function readFullSelection(
  db: ProjectDatabase,
  addresses: readonly EntityReadItem<EntityIdentity>[],
): EntityReadItem<ProjectEntity>[] {
  const ids = new Set(selectedIds(addresses));
  if (addresses.some((item) => item.ok && item.entity.kind === "document")) {
    ids.add(db.projectId);
  }
  const records = new Map(db.getMany([...ids]).map((record) => [record.id, record]));
  const reader = new EntityReader(db, records.get(db.projectId) ?? null);
  return assembleReadItems(addresses, records, (record) => reader.decode(record));
}

/**
 * Читает краткие SQL-проекции выбранных ID; полные записи, проект и журналы не загружаются.
 */
function readSummarySelection(
  db: ProjectDatabase,
  addresses: readonly EntityReadItem<EntityIdentity>[],
): EntityReadItem<EntitySummary>[] {
  const rows = db.getManySummaries(selectedIds(addresses));
  const records = new Map(rows.filter((row) => row !== null).map((row) => [row.id, row]));
  return assembleReadItems(addresses, records, decodeEntitySummary);
}

/**
 * Собирает групповое представление в уже удерживаемом снимке после проверки формы запроса.
 * Поколение, разрешение ссылок, содержание и зависимый каталог относятся к одному состоянию БД.
 */
export function readEntitySelection(
  db: ProjectDatabase,
  refs: readonly string[],
  options: EntityReadOptions,
): EntityReadResult {
  const generation = db.getGeneration();
  const addresses = resolveReadAddresses(db, refs);
  if (options.summary) {
    return { view: "summary", generation, items: readSummarySelection(db, addresses) };
  }
  return { view: "full", generation, items: readFullSelection(db, addresses) };
}
