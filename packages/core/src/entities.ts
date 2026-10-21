import { isDeepStrictEqual } from "node:util";
import {
  RelayError,
  isEntityKind,
  validateActor,
  type EntityIdentity,
  type EntityKind,
  type EntityRecord,
  type WriteOptions,
} from "@relay/contracts";
import type { ProjectDatabase } from "@relay/storage";

function validateText(value: string, field: string, key = false): void {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim() ||
    /\p{Cc}/u.test(value) ||
    (key && /[\s:]/u.test(value))
  ) {
    throw new RelayError("VALIDATION_ERROR", `Некорректное поле: ${field}.`, 2, { field });
  }
}

function validateData(data: Record<string, unknown>): void {
  const parents = new Set<object>();
  const visit = (value: unknown): void => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (typeof value !== "object" || parents.has(value)) {
      throw new RelayError("VALIDATION_ERROR", "Данные должны быть конечным JSON-объектом.", 2);
    }
    if (
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      throw new RelayError("VALIDATION_ERROR", "Данные должны содержать только JSON-значения.", 2);
    }
    parents.add(value);
    // Итератор массива посещает и пропуски: undefined нельзя молча сохранить как null.
    for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child);
    parents.delete(value);
  };
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new RelayError("VALIDATION_ERROR", "Ожидается объект данных.", 2);
  }
  visit(data);
}

function validateWrite(entity: EntityRecord, options: WriteOptions): void {
  validateActor(options.actor);
  if (!Number.isSafeInteger(options.ifRevision) || options.ifRevision < 1) {
    throw new RelayError("VALIDATION_ERROR", "Требуется положительная целая ревизия.", 2);
  }
  if (entity.revision !== options.ifRevision) {
    throw new RelayError("REVISION_CONFLICT", "Запись уже изменена; перечитайте её ревизию.", 4, {
      id: entity.id,
      expectedRevision: options.ifRevision,
      actualRevision: entity.revision,
    });
  }
}

/** Внутренний примитив Core: разрешение адресов и запись уже проверенного предметным сервисом JSON. */
export class EntityService {
  constructor(private readonly db: ProjectDatabase) {}

  /**
   * Разрешает kind:ref, ID, ключи и алиасы в одном снимке без загрузки содержания.
   * Slug/prefix доступны для board/application при явном или ожидаемом виде;
   * прямой адрес имеет приоритет. Неоднозначный виртуальный адрес — CORRUPT_DATA.
   */
  resolve(ref: string, kind?: EntityKind): EntityIdentity {
    return this.db.snapshot(() => this.resolveInSnapshot(ref, kind));
  }

  /** Разрешение адреса и полная карточка относятся к одному снимку, включая конкурентный rename. */
  get(ref: string, kind?: EntityKind): EntityRecord {
    return this.db.snapshot(() => {
      const identity = this.resolveInSnapshot(ref, kind);
      const record = this.db.get(identity.id, identity.kind);
      if (!record) {
        throw new RelayError("CORRUPT_DATA", "Разрешённая запись отсутствует в снимке.", 1, {
          id: identity.id,
        });
      }
      return record;
    });
  }

  /** Вызывается только из resolve/get под их снимком; повторный snapshot здесь не нужен. */
  private resolveInSnapshot(ref: string, kind?: EntityKind): EntityIdentity {
    validateText(ref, "ref");
    const colon = ref.indexOf(":");
    if (colon !== -1) {
      const explicitKind = ref.slice(0, colon);
      const address = ref.slice(colon + 1);
      if (!isEntityKind(explicitKind) || !address.trim() || address.includes(":")) {
        throw new RelayError("INVALID_ARGUMENT", "Ожидается ссылка вида kind:ID или kind:ref.", 2);
      }
      if (kind !== undefined && kind !== explicitKind) {
        throw new RelayError("INVALID_ARGUMENT", `Ожидалась ссылка вида ${kind}.`, 2);
      }
      // Сначала разбираем синтаксис, даже если в старой базе есть такой буквальный ключ.
      kind = explicitKind;
      ref = address;
      validateText(ref, "ref");
    }
    const entity = this.db.getIdentity(ref, kind);
    if (entity) return entity;
    if (kind === "board" || kind === "application") {
      const virtual = this.db.findAddressIdentities(ref, kind);
      if (virtual.length > 1) {
        throw new RelayError("CORRUPT_DATA", "Адрес принадлежит нескольким записям.", 1, {
          ref,
          kind,
        });
      }
      if (virtual[0]) return virtual[0];
    }
    throw new RelayError("NOT_FOUND", "Запись не найдена.", 3, { ref, kind });
  }

  list(kind?: EntityKind): EntityRecord[] {
    return this.db.list(kind);
  }

  create(
    kind: EntityKind,
    prefix: string,
    data: Record<string, unknown>,
    actor: string,
    key?: string,
  ): EntityRecord {
    validateActor(actor);
    validateText(prefix, "prefix", true);
    if (key !== undefined) validateText(key, "key", true);
    validateData(data);
    return this.db.transaction(() => {
      let allocatedKey = key ?? this.db.nextKey(prefix);
      if (key === undefined && (kind === "board" || kind === "application")) {
        const reserved = new Set(
          this.db.list(kind).flatMap((entity) => [entity.data.slug, entity.data.prefix]),
        );
        // Виртуальный адрес так же занят, как ключ или алиас в реестре Storage.
        while (reserved.has(allocatedKey)) allocatedKey = this.db.nextKey(prefix);
      }
      const now = new Date().toISOString();
      const entity: EntityRecord = {
        id: crypto.randomUUID(),
        kind,
        key: allocatedKey,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        createdBy: actor,
        updatedBy: actor,
        data: structuredClone(data),
      };
      this.checkAddresses(entity);
      this.db.insert(entity);
      return this.get(entity.id);
    });
  }

  update(
    ref: string,
    kind: EntityKind,
    patch: Record<string, unknown>,
    options: WriteOptions,
  ): EntityRecord {
    validateData(patch);
    return this.db.transaction(() => {
      const current = this.get(ref, kind);
      // Даже повторная запись тех же значений не принимает устаревшую ревизию.
      validateWrite(current, options);
      const data = { ...current.data, ...structuredClone(patch) };
      // Комментарии — проекция отдельного журнала, а не изменяемое содержание задачи.
      if (kind === "task") data.comments = current.data.comments;
      if (isDeepStrictEqual(current.data, data)) return current;
      const entity = {
        ...current,
        data,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
        updatedBy: options.actor,
      };
      this.db.update(entity, options.ifRevision);
      return this.get(entity.id);
    });
  }

  rename(ref: string, kind: EntityKind, key: string, options: WriteOptions): EntityRecord {
    validateText(key, "key", true);
    return this.db.transaction(() => {
      const current = this.get(ref, kind);
      validateWrite(current, options);
      this.checkAddresses({ ...current, key });
      return this.db.rename(current.id, key, options.ifRevision, options.actor);
    });
  }

  private checkAddresses(entity: EntityRecord): void {
    if (entity.kind !== "board" && entity.kind !== "application") return;
    const others = this.db.list(entity.kind).filter((record) => record.id !== entity.id);
    // Ключи, алиасы и виртуальные адреса одного вида не могут менять владельца.
    // Проверяем оба направления: новый ключ и новые slug/prefix при создании.
    for (const address of [entity.key, entity.data.slug, entity.data.prefix]) {
      if (typeof address !== "string" || !address) continue;
      const stored = this.db.get(address, entity.kind);
      if (
        (stored && stored.id !== entity.id) ||
        others.some((record) => record.data.slug === address || record.data.prefix === address)
      ) {
        throw new RelayError("CONFLICT", `Адрес ${address} уже занят другой записью.`, 4, {
          kind: entity.kind,
          ref: address,
        });
      }
    }
  }
}
