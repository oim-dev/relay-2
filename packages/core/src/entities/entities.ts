import { isDeepStrictEqual } from "node:util";
import {
  RelayError,
  validateActor,
  type EntityIdentity,
  type EntityKind,
  type EntityRecord,
  type WriteOptions,
} from "@relay/contracts";
import type { ProjectDatabase } from "@relay/storage";
import {
  allocateEntityKey,
  resolveEntityIdentity,
  validateEntityAddresses,
} from "./entity-addresses";
import { entityMessages } from "./entity.messages";
import type { EntityMutationOptions, PrepareEntityChange } from "./entity.types";
import {
  validateEntityAddress,
  validateEntityData,
  validateEntityWrite,
} from "./entity-validation";

/**
 * Внутренний примитив Core: адресация и атомарная запись предметно проверенного JSON.
 * Предметные инварианты принадлежат вызывающим сервисам; этот класс не входит в публичный Core.
 */
export class EntityService {
  /* Соединение выбранного проекта; ресурсом и внешней транзакцией владеет вызывающий код. */
  private readonly db: ProjectDatabase;

  /**
   * Привязывает внутренние операции к открытому соединению, не меняя срок его жизни.
   */
  constructor(db: ProjectDatabase) {
    this.db = db;
  }

  /**
   * Разрешает kind:ref, ID, ключи и алиасы в одном снимке без загрузки содержания.
   * Slug/prefix доступны для board/application при явном или ожидаемом виде;
   * прямой адрес имеет приоритет. Неоднозначный виртуальный адрес — CORRUPT_DATA.
   */
  resolve(ref: string, kind?: EntityKind): EntityIdentity {
    return this.db.snapshot(() => resolveEntityIdentity(this.db, ref, kind));
  }

  /**
   * Читает полную карточку и актуальную проекцию комментариев в одном снимке с адресацией.
   * Конкурентное переименование не меняет разрешённую цель; отсутствие цели даёт NOT_FOUND.
   */
  get(ref: string, kind?: EntityKind): EntityRecord {
    return this.db.snapshot(() => {
      const identity = resolveEntityIdentity(this.db, ref, kind);
      const record = this.db.get(identity.id, identity.kind);
      if (!record) {
        throw new RelayError("CORRUPT_DATA", entityMessages.missingResolvedRecord, 1, {
          id: identity.id,
        });
      }
      return record;
    });
  }

  /**
   * Загружает все карточки выбранного вида либо проекта целиком, включая комментарии задач.
   * Составное чтение с другими запросами должно удерживать внешний snapshot.
   */
  list(kind?: EntityKind): EntityRecord[] {
    return this.db.list(kind);
  }

  /**
   * Создаёт независимую копию проверенного содержания с начальной ревизией 1.
   * Проверка адресов, выделение ключа и insert атомарны; отказ откатывает также счётчик.
   * Предметную форму проверяет вызывающий сервис, JSON-совместимость — этот примитив.
   */
  create(
    kind: EntityKind,
    prefix: string,
    data: Readonly<Record<string, unknown>>,
    actor: string,
    key?: string,
  ): EntityRecord {
    validateActor(actor);
    validateEntityAddress(prefix, "prefix");
    if (key !== undefined) {
      validateEntityAddress(key, "key");
    }
    validateEntityData(data);
    return this.db.transaction(() => {
      const allocatedKey = allocateEntityKey(this.db, kind, prefix, key);
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
      validateEntityAddresses(this.db, entity);
      this.db.insert(entity);
      return this.get(entity.id);
    });
  }

  /**
   * Атомарно объединяет проверенный patch с содержанием после проверки ревизии владельца.
   * CAS выполняется до no-op: неизменный patch сохраняет ревизию, дату и поколение.
   * Проекция комментариев задачи берётся из актуального журнала и не заменяется patch.
   */
  update(
    ref: string,
    kind: EntityKind,
    patch: Readonly<Record<string, unknown>>,
    options: Readonly<WriteOptions>,
  ): EntityRecord {
    validateEntityData(patch);
    return this.change(ref, kind, options, () => ({ patch }));
  }

  /**
   * Атомарно меняет ключ с сохранением старого адреса как алиаса той же записи.
   * Ожидаемая ревизия принадлежит сущности и проверяется до no-op; занятый адрес даёт CONFLICT.
   */
  rename(
    ref: string,
    kind: EntityKind,
    key: string,
    options: Readonly<WriteOptions>,
  ): EntityRecord {
    validateEntityAddress(key, "key");
    return this.change(ref, kind, options, () => ({ key }));
  }

  /**
   * Читает владельца и готовит предметное изменение внутри одной транзакции после CAS.
   * Callback получает копию актуальной карточки, а не переданный извне доверенный снимок.
   * Если подготовка сама изменила БД, владелец перечитывается и CAS проверяется повторно,
   * включая no-op. Обычная подготовка без записи не требует повторной загрузки содержания.
   * Запись сохраняет алиасы и журнал; комментарии задач никогда не заменяются patch.
   */
  change(
    ref: string,
    kind: EntityKind,
    options: Readonly<WriteOptions>,
    prepare: PrepareEntityChange,
  ): EntityRecord {
    return this.mutate(ref, kind, { kind: "explicit", write: options }, prepare);
  }

  /**
   * Изменяет запись под её ревизией, прочитанной внутри внутреннего шага сценария:
   * зависимая доска после CAS приложения либо заполнение пустого паспорта продукта.
   * Предметные условия и внешнюю транзакцию удерживает вызывающий сервис;
   * пользовательские update/rename передают свою ожидаемую ревизию через change.
   * Карточка извне не принимается; подготовка и no-op имеют гарантии change.
   */
  changeRelated(
    ref: string,
    kind: EntityKind,
    actor: string,
    prepare: PrepareEntityChange,
  ): EntityRecord {
    return this.mutate(ref, kind, { kind: "related", actor }, prepare);
  }

  /**
   * Удерживает актуальное содержание и выбранную исходную ревизию до записи либо no-op.
   * Повторное чтение требуется только после вложенной записи подготовки, не между слоями Core.
   */
  private mutate(
    ref: string,
    kind: EntityKind,
    options: EntityMutationOptions,
    prepare: PrepareEntityChange,
  ): EntityRecord {
    return this.db.transaction(() => {
      const generation = this.db.getGeneration();
      let current = this.get(ref, kind);
      const write =
        options.kind === "explicit"
          ? { actor: options.write.actor, ifRevision: options.write.ifRevision }
          : { actor: options.actor, ifRevision: current.revision };
      validateEntityWrite(current, write);
      const change = prepare(structuredClone(current));
      if (this.db.getGeneration() !== generation) {
        current = this.get(current.id, kind);
        validateEntityWrite(current, write);
      }
      let key = current.key;
      let data = current.data;
      if ("patch" in change) {
        validateEntityData(change.patch);
        data = { ...current.data, ...structuredClone(change.patch) };
        if (kind === "task") {
          data.comments = current.data.comments;
        }
      } else {
        validateEntityAddress(change.key, "key");
        key = change.key;
      }
      if (key === current.key && isDeepStrictEqual(current.data, data)) {
        return current;
      }
      const entity: EntityRecord = {
        ...current,
        key,
        data,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
        updatedBy: write.actor,
      };
      if (key !== current.key) {
        validateEntityAddresses(this.db, entity);
      }
      this.db.update(entity, write.ifRevision);
      // Журнал имеет независимую ревизию: возвращаем его актуальную проекцию.
      return kind === "task" ? this.get(entity.id, kind) : entity;
    });
  }
}
