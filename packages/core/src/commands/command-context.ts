import {
  RelayError,
  type CommandStore,
  type CommandSelector,
  type CommandObservation,
  type CommandReadAnchor,
  type CommandGuard,
  type CommandEffect,
  type CommandTransition,
  type CommandEntityVersions,
  type CommandCounter,
  type EntityRecord,
  type EntityIdentity,
  type EntityKind,
  type ExpectedEntityAddress,
} from "@relay/contracts";
import { parseEntityReference } from "../entities/entity-addresses";
import { TaskGraphCache } from "../tasks/task-command-graph";
import type { CommandKeyCursor, CommandStepTrace } from "./command-context.types";
import type { BatchOutcome } from "../batch/batch.types";
import { commandMessages } from "./command.messages";

/**
 * Явные async загрузки и разреженный overlay одного исполнения; не эмулятор ProjectStore.
 * Полнота выбранного множества учитывается отдельно от наличия карточек в кеше.
 */
export class CommandContext {
  /* ID выбранного проекта. */
  readonly projectId: string;
  /* Дословно проверенный автор. */
  readonly actor: string;
  /* Стабильное время подготовки этой операции. */
  readonly timestamp: string;
  /* Один чистый рассчитанный граф текущего overlay-состояния для задач и планирования. */
  readonly taskGraphCache = new TaskGraphCache();
  /* Единственная внешняя I/O-граница команд. */
  private readonly store: CommandStore;
  /* Ожидаемые пользователем привязки прочитанных адресов. */
  private readonly expectedAddresses: ReadonlyMap<string, string>;
  /* Неизменная идентичность исходного состояния загрузок. */
  private anchor: CommandReadAnchor | null = null;
  /* Исходные логические выборки; отсутствие результата тоже кешируется. */
  private readonly selections = new Map<string, CommandObservation>();
  /* Исходные guards всех использованных выборок. */
  private readonly guards = new Map<string, CommandGuard>();
  /* Только загруженные полные исходные записи. */
  private readonly base = new Map<string, EntityRecord>();
  /* Переносимые токены исходных полных записей; overlay не выдаёт их за свежие версии. */
  private readonly versions = new Map<string, CommandEntityVersions>();
  /* Только собственные изменённые или созданные записи. */
  private readonly overlay = new Map<string, EntityRecord>();
  /* Новые ID, ключи и алиасы текущего batch. */
  private readonly addresses = new Map<string, string>();
  /* Предварительно выбранные свободные ключи, ещё не принадлежащие SQL. */
  private readonly reservedKeys = new Set<string>();
  /* Выделенные UUID текущей операции. */
  private readonly allocatedIds = new Set<string>();
  /* Объединённые изменения counters по префиксу. */
  private readonly keyCursors = new Map<string, CommandKeyCursor>();
  /* Полностью законченные границы команд в исходном порядке. */
  private readonly tape: CommandTransition[] = [];
  /* Материал текущего предметного шага; отсутствует до beginStep. */
  private step: CommandStepTrace | undefined;
  /* Последовательность загрузок закрепляет anchor даже при Promise.all в предметном loader. */
  private loadTail: Promise<void> = Promise.resolve();
  /* Первый отказ отменяет ещё не начатые загрузки, чтобы они не пережили закрытие ресурса. */
  private loadFailure: { readonly error: unknown } | null = null;

  /**
   * Создаёт локальный контекст без чтения БД; I/O начинается только явными методами loader.
   */
  constructor(
    store: CommandStore,
    actor: string,
    timestamp: string,
    expectedAddresses: readonly ExpectedEntityAddress[] = [],
  ) {
    this.store = store;
    this.projectId = store.projectId;
    this.actor = actor;
    this.timestamp = timestamp;
    this.expectedAddresses = new Map(
      expectedAddresses.map((entry) => {
        const parsed = parseEntityReference(entry.ref);
        return [
          parsed.kind === undefined ? parsed.ref : `${parsed.kind}:${parsed.ref}`,
          entry.expectedId,
        ];
      }),
    );
  }

  /**
   * Открывает сбор точных оснований следующей команды без повторного расчёта предыдущих.
   */
  beginStep(index: number, operation: string): void {
    this.step = {
      index,
      operation,
      reads: new Map(),
      guards: new Map(),
      predicates: [],
      effects: [],
      owners: new Set(),
      targets: new Map(),
    };
  }

  /**
   * Замораживает границу предметного шага вместе с исходными и промежуточными наблюдениями.
   */
  endStep(outcome: BatchOutcome): void {
    const step = this.requireStep();
    step.owners.add(outcome.owner.id);
    for (const output of outcome.outputs) {
      step.targets.set(output.name, output.id);
    }
    this.tape.push(
      structuredClone({
        index: step.index,
        operation: step.operation,
        actor: this.actor,
        timestamp: this.timestamp,
        targets: {
          primaryId: outcome.primary.id,
          ownerIds: [...step.owners],
          roles: Object.fromEntries(step.targets),
        },
        reads: [...step.reads.values()],
        guards: [...step.guards.values()],
        predicates: step.predicates,
        effects: step.effects,
      }),
    );
    this.step = undefined;
  }

  /**
   * Фиксирует адресную роль постоянным ID, включая явное снятие связи.
   */
  target(role: string, id: string | null): void {
    this.requireStep().targets.set(role, id);
  }

  /**
   * Фиксирует конкретного владельца CAS, не выводя его из первого прочитанного объекта.
   */
  owner(id: string): void {
    this.requireStep().owners.add(id);
  }

  /**
   * Возвращает все неизменные исходные guards для единственного commit.
   */
  expected(): readonly CommandGuard[] {
    return [...this.guards.values()];
  }

  /**
   * Возвращает идентичность реально загруженного контекста для адресного atomic commit.
   * Значение не перечитывается и не заменяется идентичностью другого соединения.
   */
  replicaId(): string {
    if (this.anchor === null) {
      throw new RelayError("CORRUPT_DATA", commandMessages.observation);
    }
    return this.anchor.replicaId;
  }

  /**
   * Возвращает законченный ordered tape; effects не схлопываются по ID.
   */
  transitions(): readonly CommandTransition[] {
    return this.tape;
  }

  /**
   * Возвращает по одному точному изменению counter на префикс.
   */
  counters(): readonly CommandCounter[] {
    return [...this.keyCursors.values()];
  }

  /**
   * Возвращает финальные загруженные карточки без дополнительного I/O и актуализации CAS.
   */
  materialize(ids: readonly string[]): EntityRecord[] {
    return ids.map((id) => {
      const record = this.overlay.get(id) ?? this.base.get(id);
      if (record === undefined) {
        throw new RelayError("CORRUPT_DATA", commandMessages.missingResult, 1, { id });
      }
      return structuredClone(record);
    });
  }

  /**
   * Проверяет принадлежность эффекта явному шагу подготовки.
   */
  private requireStep(): CommandStepTrace {
    if (this.step === undefined) {
      throw new RelayError("CORRUPT_DATA", commandMessages.missingStep);
    }
    return this.step;
  }

  /**
   * Выполняет конкретную async выборку один раз для исходного anchor.
   */
  private load(selector: CommandSelector): Promise<CommandObservation> {
    const result = this.loadTail.then(async () => {
      if (this.loadFailure !== null) {
        throw this.loadFailure.error;
      }
      try {
        return await this.readSelection(selector);
      } catch (error) {
        this.loadFailure = { error };
        throw error;
      }
    });
    this.loadTail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  /**
   * Выполняет одну загрузку после завершения предыдущей, не подменяя исходный anchor.
   */
  private async readSelection(selector: CommandSelector): Promise<CommandObservation> {
    const key = JSON.stringify(selector);
    let observation = this.selections.get(key);
    if (observation === undefined) {
      const loaded = await this.store.load({ anchor: this.anchor, selectors: [selector] });
      this.anchor = loaded.anchor;
      observation = loaded.observations[0];
      const guard = loaded.guards[0];
      if (observation === undefined || guard === undefined) {
        throw new RelayError("CORRUPT_DATA", commandMessages.observation);
      }
      this.selections.set(key, observation);
      this.guards.set(key, guard);
      if (observation.kind === "records" && selector.kind !== "task-graph") {
        for (const record of observation.records) {
          this.base.set(record.id, structuredClone(record));
          const version = observation.versions?.[record.id];
          if (version !== undefined) {
            this.versions.set(record.id, version);
          }
        }
      }
    }
    const guard = this.guards.get(key);
    if (guard !== undefined) {
      this.step?.guards.set(key, guard);
    }
    return observation;
  }

  /**
   * Сохраняет именно эффективный наблюдаемый факт, включая пустоту и собственные изменения.
   */
  private observed(selector: CommandSelector, observation: CommandObservation): void {
    if (this.step !== undefined) {
      this.step.predicates.push(structuredClone({ selector, observation }));
      if (observation.kind === "records" && selector.kind !== "task-graph") {
        for (const record of observation.records) {
          this.step.reads.set(record.id, structuredClone(record));
        }
      }
    }
  }

  /**
   * Проверяет клиентский переносимый токен исходного агрегата до любого no-op.
   * После собственных изменений старый literal token не обновляется: следующий шаг использует $revision.
   */
  assertExpectedVersion(owner: Readonly<EntityRecord>, expectedVersion: string): void {
    const base = this.base.get(owner.id);
    const observed = this.versions.get(owner.id);
    if (base !== undefined && observed === undefined) {
      throw new RelayError("CORRUPT_DATA", commandMessages.versionMetadata, 1, { id: owner.id });
    }
    const actualVersion =
      base?.revision === owner.revision ? (observed?.aggregateVersion ?? null) : null;
    if (actualVersion !== expectedVersion) {
      throw new RelayError("VERSION_CONFLICT", commandMessages.versionConflict, 4, {
        id: owner.id,
        expectedVersion,
        actualVersion,
      });
    }
  }

  /**
   * Накладывает собственные записи на полный выбранный набор, учитывая выход из состава.
   */
  private selected(
    observation: CommandObservation,
    matches: (record: EntityRecord) => boolean,
  ): EntityRecord[] {
    if (observation.kind !== "records") {
      throw new RelayError("CORRUPT_DATA", commandMessages.observation);
    }
    const records = new Map(observation.records.map((record) => [record.id, record]));
    for (const record of this.overlay.values()) {
      records.delete(record.id);
      if (matches(record)) {
        records.set(record.id, record);
      }
    }
    return [...records.values()]
      .sort((a, b) => {
        if (a.key !== b.key) {
          return a.key < b.key ? -1 : 1;
        }
        if (a.id === b.id) {
          return 0;
        }
        return a.id < b.id ? -1 : 1;
      })
      .map((record) => structuredClone(record));
  }

  /**
   * Разрешает буквальный ID/ключ/алиас без виртуального fallback, учитывая новые адреса overlay.
   */
  async identity(ref: string): Promise<EntityIdentity | null> {
    const selector: CommandSelector = { kind: "identities", refs: [ref] };
    const stagedId = this.addresses.get(ref);
    let identity: EntityIdentity | null;
    if (stagedId !== undefined) {
      const record = this.overlay.get(stagedId);
      identity =
        record === undefined ? null : { id: record.id, kind: record.kind, key: record.key };
    } else {
      const result = await this.load(selector);
      if (result.kind !== "identities") {
        throw new RelayError("CORRUPT_DATA", commandMessages.observation);
      }
      const original = result.identities[0] ?? null;
      const changed = original === null ? undefined : this.overlay.get(original.id);
      identity =
        changed === undefined ? original : { id: changed.id, kind: changed.kind, key: changed.key };
    }
    this.observed(selector, { kind: "identities", identities: [identity] });
    return identity;
  }

  /**
   * Загружает точные виртуальные совпадения выбранного вида и учитывает созданные application/board.
   */
  async virtual(ref: string, kind: EntityKind): Promise<EntityIdentity[]> {
    const selector: CommandSelector = { kind: "virtual", ref, entityKind: kind };
    const result = await this.load(selector);
    if (result.kind !== "identities") {
      throw new RelayError("CORRUPT_DATA", commandMessages.observation);
    }
    const matches = new Map(
      result.identities.flatMap((entry) => (entry === null ? [] : [[entry.id, entry] as const])),
    );
    for (const record of this.overlay.values()) {
      matches.delete(record.id);
      if (record.kind === kind && (record.data.slug === ref || record.data.prefix === ref)) {
        matches.set(record.id, { id: record.id, key: record.key, kind: record.kind });
      }
    }
    const identities = [...matches.values()].sort((a, b) => {
      if (a.id === b.id) {
        return 0;
      }
      return a.id < b.id ? -1 : 1;
    });
    this.observed(selector, { kind: "identities", identities });
    return identities;
  }

  /**
   * Проверяет пользовательский адрес и раскрывает typed/virtual ссылку без скрытой записи.
   */
  async resolve(input: string, expectedKind?: EntityKind): Promise<EntityIdentity> {
    const { ref, kind } = parseEntityReference(input, expectedKind);
    const selector: CommandSelector = { kind: "address-state", ref };
    const state = await this.load(selector);
    if (state.kind !== "address-state") {
      throw new RelayError("CORRUPT_DATA", commandMessages.observation);
    }
    let identity = await this.identity(ref);
    if (identity !== null && kind !== undefined && identity.kind !== kind) {
      identity = null;
    }
    if (identity === null && (kind === "board" || kind === "application")) {
      const virtual = await this.virtual(ref, kind);
      if (virtual.length > 1) {
        throw new RelayError("CORRUPT_DATA", commandMessages.ambiguous, 1, { ref, kind });
      }
      identity = virtual[0] ?? null;
    }
    if (identity === null) {
      throw new RelayError("NOT_FOUND", commandMessages.missing, 3, { ref, kind });
    }
    const expected =
      this.expectedAddresses.get(`${identity.kind}:${ref}`) ?? this.expectedAddresses.get(ref);
    if (state.previousId !== null && expected === undefined) {
      throw new RelayError("ADDRESS_GUARD_REQUIRED", commandMessages.addressRequired, 4, {
        ref,
        previousId: state.previousId,
        currentId: state.currentId,
      });
    }
    if (expected !== undefined && expected !== identity.id) {
      throw new RelayError("ADDRESS_CHANGED", commandMessages.addressChanged, 4, {
        ref,
        expectedId: expected,
        actualId: identity.id,
      });
    }
    return identity;
  }

  /**
   * Читает одну полную исходную карточку либо её собственное промежуточное состояние.
   */
  async get(
    ref: string,
    kind?: EntityKind,
    semantic: "content" | "existence" = "content",
  ): Promise<EntityRecord> {
    const identity = await this.resolve(ref, kind);
    const selector: CommandSelector = {
      kind: "entity",
      ref: identity.id,
      ...(kind === undefined ? {} : { entityKind: kind }),
      semantic,
    };
    const staged = this.overlay.get(identity.id);
    let record = staged;
    if (record === undefined || (semantic === "content" && this.base.has(identity.id))) {
      const result = await this.load(selector);
      if (result.kind !== "records") {
        throw new RelayError("CORRUPT_DATA", commandMessages.observation);
      }
      if (record === undefined) {
        record = result.records[0];
      }
    }
    if (record === undefined) {
      throw new RelayError("NOT_FOUND", commandMessages.missing, 3, { ref: identity.id, kind });
    }
    this.observed(selector, { kind: "records", records: [record] });
    return structuredClone(record);
  }

  /**
   * Читает пакет постоянных ID одним SQL-набором, сохраняя порядок и отсутствие чужих записей.
   */
  async getMany(ids: readonly string[], kind?: EntityKind): Promise<EntityRecord[]> {
    const selector: CommandSelector = {
      kind: "records",
      ids: [...ids],
      ...(kind === undefined ? {} : { entityKind: kind }),
    };
    const missing = ids.filter((id) => !this.overlay.has(id) || this.base.has(id));
    const result =
      missing.length === 0
        ? { kind: "records" as const, records: [] }
        : await this.load({ ...selector, ids: missing });
    const selected = new Map(
      this.selected(
        result,
        (record) => ids.includes(record.id) && (kind === undefined || record.kind === kind),
      ).map((record) => [record.id, record]),
    );
    const records = ids.flatMap((id) => {
      const record = selected.get(id);
      return record === undefined ? [] : [record];
    });
    this.observed(selector, { kind: "records", records });
    return records;
  }

  /**
   * Читает полный выбранный состав по буквальному строковому полю, не весь проект.
   */
  async byField(kind: EntityKind, field: string, value: string): Promise<EntityRecord[]> {
    const selector: CommandSelector = { kind: "field", entityKind: kind, field, value };
    const records = this.selected(
      await this.load(selector),
      (record) => record.kind === kind && record.data[field] === value,
    );
    this.observed(selector, { kind: "records", records });
    return records;
  }

  /**
   * Загружает объединение значений одного буквального поля одним SQL-набором и одним guard.
   * Пустой набор является тождественно пустым предикатом и не требует SQL.
   */
  async byFields(
    kind: EntityKind,
    field: string,
    values: readonly string[],
  ): Promise<EntityRecord[]> {
    const selected = [...new Set(values)].sort();
    const selector: CommandSelector = {
      kind: "field-set",
      entityKind: kind,
      field,
      values: selected,
    };
    const source: CommandObservation =
      selected.length === 0 ? { kind: "records", records: [] } : await this.load(selector);
    const records = this.selected(
      source,
      (record) =>
        record.kind === kind &&
        typeof record.data[field] === "string" &&
        selected.includes(record.data[field]),
    );
    this.observed(selector, { kind: "records", records });
    return records;
  }

  /**
   * Явно загружает выбранный предметный вид для сценариев, которым нужен полный состав этого вида.
   */
  async list(kind: EntityKind): Promise<EntityRecord[]> {
    const selector: CommandSelector = { kind: "kind", entityKind: kind };
    const records = this.selected(await this.load(selector), (record) => record.kind === kind);
    this.observed(selector, { kind: "records", records });
    return records;
  }

  /**
   * Загружает узкую базовую графовую проекцию один раз; свои изменения накладываются на каждый state.
   */
  async graphRecords(): Promise<EntityRecord[]> {
    const selector: CommandSelector = { kind: "task-graph" };
    const records = this.selected(await this.load(selector), (record) => record.kind === "task");
    this.observed(selector, { kind: "records", records });
    return records;
  }

  /**
   * Выбирает планы с включениями указанной задачи, включая собственные добавления/снятия.
   */
  async memberships(taskId: string): Promise<EntityRecord[]> {
    const selector: CommandSelector = { kind: "memberships", taskId };
    const records = this.selected(
      await this.load(selector),
      (record) =>
        record.kind === "work-plan" &&
        Array.isArray(record.data.stages) &&
        record.data.stages.some(
          (stage: unknown) =>
            stage !== null &&
            typeof stage === "object" &&
            "taskIds" in stage &&
            Array.isArray(stage.taskIds) &&
            stage.taskIds.includes(taskId),
        ),
    );
    this.observed(selector, { kind: "records", records });
    return records;
  }

  /**
   * Проверяет занятость append-only ID участия без чтения содержания чужих сессий.
   */
  async arrayItemExists(
    kind: EntityKind,
    arrayField: string,
    itemField: string,
    value: string,
  ): Promise<boolean> {
    const selector: CommandSelector = {
      kind: "array-item",
      entityKind: kind,
      arrayField,
      itemField,
      value,
    };
    const result = await this.load(selector);
    if (result.kind !== "boolean") {
      throw new RelayError("CORRUPT_DATA", commandMessages.observation);
    }
    const found =
      result.value ||
      [...this.overlay.values()].some(
        (record) =>
          record.kind === kind &&
          Array.isArray(record.data[arrayField]) &&
          record.data[arrayField].some(
            (entry: unknown) =>
              entry !== null &&
              typeof entry === "object" &&
              Reflect.get(entry, itemField) === value,
          ),
      );
    this.observed(selector, { kind: "boolean", value: found });
    return found;
  }

  /**
   * Выбирает свободный ключ read-only и сохраняет один исходный counter guard на весь префикс.
   */
  async key(kind: EntityKind, prefix: string): Promise<string> {
    const cursor = this.keyCursors.get(prefix);
    const virtualAddresses: string[] = [];
    if (kind === "application" || kind === "board") {
      for (const record of this.overlay.values()) {
        if (record.kind !== kind) {
          continue;
        }
        for (const address of [record.data.slug, record.data.prefix]) {
          if (typeof address === "string") {
            virtualAddresses.push(address);
          }
        }
      }
    }
    const selector: CommandSelector = {
      kind: "key",
      entityKind: kind,
      prefix,
      after: cursor?.after ?? 0,
      excluded: [...new Set([...this.addresses.keys(), ...this.reservedKeys, ...virtualAddresses])],
    };
    const result = await this.load(selector);
    if (result.kind !== "key") {
      throw new RelayError("CORRUPT_DATA", commandMessages.observation);
    }
    this.keyCursors.set(prefix, {
      prefix,
      before: cursor?.before ?? result.before,
      after: result.value,
    });
    this.reservedKeys.add(result.key);
    return result.key;
  }

  /**
   * Выделяет UUID до чистого расчёта; уникальность внешнего пространства проверяет loader/commit.
   */
  allocateId(): string {
    for (let attempt = 0; attempt < 32; attempt++) {
      const id = crypto.randomUUID();
      if (!this.allocatedIds.has(id)) {
        this.allocatedIds.add(id);
        return id;
      }
    }
    throw new RelayError("CONFLICT", commandMessages.effectChain, 4);
  }

  /**
   * Накладывает точные эффекты на память одного исполнения, без I/O и генерации метаданных.
   */
  apply(effects: readonly CommandEffect[]): void {
    const step = this.requireStep();
    for (const effect of effects) {
      if (effect.kind === "entity") {
        const current = this.overlay.get(effect.after.id) ?? this.base.get(effect.after.id);
        if (
          effect.before !== null &&
          current !== undefined &&
          current.revision !== effect.before.revision
        ) {
          throw new RelayError("CORRUPT_DATA", commandMessages.effectChain);
        }
        const staged = structuredClone(effect.after);
        if (staged.kind === "task" && current?.kind === "task") {
          // Как и в SQLite, содержание не заменяет независимо дописанный журнал.
          staged.data.comments = structuredClone(current.data.comments);
        }
        this.overlay.set(effect.after.id, staged);
        this.addresses.set(effect.after.id, effect.after.id);
        this.addresses.set(effect.after.key, effect.after.id);
        if (effect.before !== null) {
          this.addresses.set(effect.before.key, effect.before.id);
        }
      } else {
        const task = this.overlay.get(effect.taskId) ?? this.base.get(effect.taskId);
        if (task === undefined) {
          throw new RelayError("CORRUPT_DATA", commandMessages.effectChain);
        }
        const comments: unknown[] = Array.isArray(task.data.comments) ? task.data.comments : [];
        this.overlay.set(task.id, {
          ...structuredClone(task),
          data: {
            ...structuredClone(task.data),
            comments: [...comments, structuredClone(effect.comment)],
          },
        });
      }
      step.effects.push(structuredClone(effect));
    }
  }
}
