import {
  RelayError,
  isEntityKind,
  type BatchIdentity,
  type BatchOutput,
  type BatchRevisionOwner,
  type BatchResultKind,
  type EntityKind,
  type EntityRecord,
  type WriteOptions,
} from "@relay/contracts";
import type { ProjectDatabase } from "@relay/storage";
import { EntityService } from "../entities/entities";
import { KnowledgeService } from "../knowledge/knowledge";
import { TasksService } from "../tasks/tasks";
import { PlanningService } from "../planning/planning";
import { HistoryService } from "../history/history";
import { batchReference, batchRevision, batchText, invalidBatch } from "./batch-input";
import { batchMessages } from "./batch.messages";
import { resolveBatchInput } from "./batch-references";
import { locateBatchError } from "./batch-errors";
import type {
  BatchActionDescriptor,
  BatchExecutionState,
  BatchOutcome,
  BatchStep,
} from "./batch.types";

/**
 * Копирует компактную идентичность самостоятельной записи; полная карточка для этого не нужна.
 */
export function batchIdentity(record: BatchRevisionOwner): BatchRevisionOwner {
  return { id: record.id, kind: record.kind, key: record.key, revision: record.revision };
}

/**
 * Контекст одного шага в общей транзакции. Сервисы используют то же соединение;
 * разрешение ссылок и проверка владельца CAS явны в предметном адаптере.
 */
export class BatchStepContext {
  /* Соединение общей транзакции, принадлежащее вызывающему приложению. */
  readonly db: ProjectDatabase;
  /* Существующий предметный владелец знаний. */
  readonly knowledge: KnowledgeService;
  /* Существующий предметный владелец задач и их графов. */
  readonly tasks: TasksService;
  /* Существующий предметный владелец планирования. */
  readonly planning: PlanningService;
  /* Существующий предметный владелец истории. */
  readonly history: HistoryService;
  /* Исходная оболочка шага с явно переданной ревизией. */
  readonly step: BatchStep;
  /* Проверяемая предметным сервисом граница ввода с раскрытыми адресными полями. */
  readonly input: Readonly<Record<string, unknown>>;
  /* Общий автор пакета. */
  readonly actor: string;
  /* Индекс операции для диагностики и разрешения путей. */
  readonly index: number;
  /* Состояние локальных результатов только текущего пакета. */
  private readonly state: BatchExecutionState;
  /* Общий механизм адресации, без записи сырых данных. */
  private readonly entities: EntityService;

  /**
   * Создаёт адаптер без открытия БД и раскрывает только объявленные адресные поля input.
   */
  constructor(
    db: ProjectDatabase,
    step: BatchStep,
    action: BatchActionDescriptor,
    index: number,
    actor: string,
    state: BatchExecutionState,
  ) {
    this.db = db;
    this.step = step;
    this.index = index;
    this.actor = actor;
    this.state = state;
    this.entities = new EntityService(db);
    this.knowledge = new KnowledgeService(db);
    this.tasks = new TasksService(db);
    this.planning = new PlanningService(db);
    this.history = new HistoryService(db);
    this.input = resolveBatchInput(step.input, action.addresses, this);
  }

  /**
   * Возвращает абсолютный путь поля текущей операции.
   */
  path(field: string): string {
    return `operations[${this.index}].${field}`;
  }

  /**
   * Разрешает $ref в основной ID предыдущего результата и проверяет вид локальной цели.
   * Строковый адрес самостоятельной сущности разрешается стандартным resolver без чтения тела.
   * Вложенный ID проверяется владельцем предметного состава, а не пространством entity_refs.
   */
  address(value: unknown, field: string, kinds: readonly BatchResultKind[] = []): string {
    try {
      const reference = batchReference(value, this.path(field));
      if (typeof reference !== "string") {
        const result = this.state.aliases.get(reference.$ref);
        if (result === undefined) {
          invalidBatch(batchMessages.missingAlias, this.path(field));
        }
        if (
          (kinds.length > 0 && !kinds.includes(result.kind)) ||
          (kinds.length === 0 && !isEntityKind(result.kind))
        ) {
          invalidBatch(batchMessages.referenceKind, this.path(field));
        }
        return result.id;
      }
      if (kinds.some((kind) => !isEntityKind(kind))) {
        return reference;
      }
      const expected = kinds.length === 1 && isEntityKind(kinds[0]) ? kinds[0] : undefined;
      const identity = this.entities.resolve(reference, expected);
      if (kinds.length > 0 && !kinds.includes(identity.kind)) {
        invalidBatch(batchMessages.referenceKind, this.path(field));
      }
      return identity.id;
    } catch (error) {
      throw locateBatchError(error, this.index, this.step.op, field);
    }
  }

  /**
   * Разрешает обязательный верхнеуровневый ref ожидаемого предметного вида.
   */
  ref(kind: EntityKind): string {
    return this.address(this.step.ref, "ref", [kind]);
  }

  /**
   * Извлекает уже раскрытый позиционный адрес либо текст, не приводя неизвестное значение к строке.
   */
  text(field: string): string {
    return batchText(this.input[field], this.path(`input.${field}`));
  }

  /**
   * Читает текст позиционного ввода дословно; предметные ограничения применяет вызываемый сервис.
   */
  string(field: string, fallback?: string): string {
    const value = this.input[field] === undefined ? fallback : this.input[field];
    if (typeof value !== "string") {
      invalidBatch(batchMessages.text, this.path(`input.${field}`));
    }
    return value;
  }

  /**
   * Проверяет форму массива строковых адресов после локальной подстановки без приведения типов.
   */
  strings(field: string): string[] {
    const value = this.input[field];
    if (!Array.isArray(value)) {
      invalidBatch(batchMessages.reference, this.path(`input.${field}`));
    }
    return value.map((entry, index) => batchText(entry, this.path(`input.${field}[${index}]`)));
  }

  /**
   * Проверяет явно переданную ревизию правильного владельца до вызова мутации и no-op.
   * $revision не даёт права первой правки существующей записи через результат чтения/комментария.
   */
  write(owner: Readonly<EntityRecord>): WriteOptions {
    return this.writeRevision(owner, this.step.ifRevision, "ifRevision");
  }

  /**
   * Проверяет явно выбранное поле CAS дополнительного владельца; отсутствие значения всегда ошибка.
   * Верхний ifRevision не служит значением по умолчанию для второго плана переноса.
   */
  writeRevision(owner: Readonly<EntityRecord>, value: unknown, field: string): WriteOptions {
    const requested = batchRevision(value, this.path(field));
    let revision: number;
    if (typeof requested === "number") {
      revision = requested;
    } else {
      const result = this.state.aliases.get(requested.$revision);
      if (result === undefined) {
        invalidBatch(batchMessages.missingAlias, this.path(field));
      }
      if (result.owner.id !== owner.id) {
        invalidBatch(batchMessages.revisionOwner, this.path(field));
      }
      if (!this.state.authorizedOwners.has(owner.id)) {
        invalidBatch(batchMessages.firstRevision, this.path(field));
      }
      revision = result.owner.revision;
    }
    if (revision !== owner.revision) {
      throw new RelayError("REVISION_CONFLICT", batchMessages.conflictRevision, 4, {
        path: this.path(field),
        id: owner.id,
        expectedRevision: revision,
        actualRevision: owner.revision,
      });
    }
    this.state.authorizedOwners.add(owner.id);
    return { actor: this.actor, ifRevision: revision };
  }

  /**
   * Помечает созданную в текущем пакете самостоятельную запись для последующего $revision.
   */
  created(record: Readonly<Pick<EntityRecord, "id">>): void {
    this.state.authorizedOwners.add(record.id);
  }

  /**
   * Регистрирует изменённые либо неявно созданные записи для единственной итоговой выборки.
   */
  touch(...records: readonly Readonly<Pick<EntityRecord, "id">>[]): void {
    for (const record of records) {
      this.state.touched.add(record.id);
    }
  }

  /**
   * Формирует основной выход самостоятельной сущности; отдельный owner нужен FI/SI и истории.
   */
  result(
    record: Readonly<EntityRecord>,
    owner: Readonly<EntityRecord> = record,
    outputs: readonly BatchOutput[] = [],
  ): BatchOutcome {
    this.touch(record, owner);
    return { primary: batchIdentity(record), owner: batchIdentity(owner), outputs };
  }

  /**
   * Формирует основной выход вложенного объекта; ревизией владеет его агрегат.
   */
  nested(
    id: string | undefined,
    kind: BatchResultKind,
    owner: Readonly<EntityRecord>,
    outputs: readonly BatchOutput[] = [],
  ): BatchOutcome {
    if (id === undefined) {
      throw new RelayError("CORRUPT_DATA", batchMessages.missingOutput);
    }
    this.touch(owner);
    const primary: BatchIdentity = { id, kind, key: null, revision: owner.revision };
    return { primary, owner: batchIdentity(owner), outputs };
  }
}
