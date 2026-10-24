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
import type { CommandContext } from "../commands/command-context";
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
 * Контекст одного шага подготовки: explicit loaders используют общий command context,
 * pure calculators получают значения. Сохранением единственного плана владеет executor.
 */
export class BatchStepContext {
  /* Явные async загрузки, выделение метаданных и разреженный overlay. */
  readonly commands: CommandContext;
  /* Исходная оболочка шага с явно переданной ревизией. */
  readonly step: BatchStep;
  /* Проверяемая предметным сервисом граница ввода с раскрытыми адресными полями. */
  input: Readonly<Record<string, unknown>>;
  /* Общий автор пакета. */
  readonly actor: string;
  /* Индекс операции для диагностики и разрешения путей. */
  readonly index: number;
  /* Состояние локальных результатов только текущего пакета. */
  private readonly state: BatchExecutionState;
  /* Совместимость точечного фасада: conditional-create, singleton ref и literal acceptedSessionIds. */
  readonly implicitCreation: boolean;
  /* Адресные поля единственного описателя действия. */
  private readonly action: BatchActionDescriptor;

  /**
   * Создаёт адаптер без открытия БД и раскрывает только объявленные адресные поля input.
   */
  constructor(
    commands: CommandContext,
    step: BatchStep,
    action: BatchActionDescriptor,
    index: number,
    actor: string,
    state: BatchExecutionState,
    implicitCreation = false,
  ) {
    this.commands = commands;
    this.step = step;
    this.index = index;
    this.actor = actor;
    this.state = state;
    this.implicitCreation = implicitCreation;
    this.action = action;
    this.input = step.input;
  }

  /**
   * Разрешает только объявленные адресные позиции до предметного loader.
   */
  async prepare(): Promise<void> {
    this.input = await resolveBatchInput(this.step.input, this.action.addresses, this);
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
  async address(
    value: unknown,
    field: string,
    kinds: readonly BatchResultKind[] = [],
  ): Promise<string> {
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
        this.commands.target(field, result.id);
        return result.id;
      }
      if (kinds.some((kind) => !isEntityKind(kind))) {
        this.commands.target(field, reference);
        return reference;
      }
      const expected = kinds.length === 1 && isEntityKind(kinds[0]) ? kinds[0] : undefined;
      const identity = await this.commands.resolve(reference, expected);
      if (kinds.length > 0 && !kinds.includes(identity.kind)) {
        invalidBatch(batchMessages.referenceKind, this.path(field));
      }
      this.commands.target(field, identity.id);
      return identity.id;
    } catch (error) {
      throw locateBatchError(error, this.index, this.step.op, field);
    }
  }

  /**
   * Разрешает обязательный верхнеуровневый ref ожидаемого предметного вида.
   */
  ref(kind: EntityKind): Promise<string> {
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
    if (this.step.expectedVersion !== undefined) {
      this.checkVersion(owner, this.step.expectedVersion, "expectedVersion");
      if (this.step.ifRevision === undefined) {
        this.state.authorizedOwners.add(owner.id);
        this.commands.owner(owner.id);
        return { actor: this.actor, ifRevision: owner.revision };
      }
    }
    if (
      this.implicitCreation &&
      this.step.ifRevision === undefined &&
      (this.step.op === "product.create" || this.step.op === "implementation.create")
    ) {
      this.commands.owner(owner.id);
      return { actor: this.actor, ifRevision: owner.revision };
    }
    return this.writeRevision(owner, this.step.ifRevision, "ifRevision");
  }

  /**
   * Проверяет явно выбранное поле CAS дополнительного владельца; отсутствие значения всегда ошибка.
   * Верхний ifRevision не служит значением по умолчанию для второго плана переноса.
   */
  writeRevision(
    owner: Readonly<EntityRecord>,
    value: unknown,
    field: string,
    expectedVersion?: unknown,
  ): WriteOptions {
    if (expectedVersion !== undefined) {
      this.checkVersion(
        owner,
        batchText(expectedVersion, this.path("input.targetVersion")),
        "input.targetVersion",
      );
    }
    const requested =
      value === undefined && expectedVersion !== undefined
        ? owner.revision
        : batchRevision(value, this.path(field));
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
    this.commands.owner(owner.id);
    return { actor: this.actor, ifRevision: revision };
  }

  /**
   * Проверяет исходный переносимый токен с координатами именно его адресной роли.
   */
  private checkVersion(
    owner: Readonly<EntityRecord>,
    expectedVersion: string,
    field: string,
  ): void {
    try {
      this.commands.assertExpectedVersion(owner, expectedVersion);
    } catch (error) {
      throw locateBatchError(error, this.index, this.step.op, field);
    }
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
