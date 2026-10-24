import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  RelayError,
  type BatchResult,
  type CommandCommitFacts,
  type CommandCommitPlan,
  type CommandEffect,
  type CommandEntityVersions,
  type CommandGuard,
  type CommandLoadResult,
  type CommandSelector,
  type CommandTransition,
  type EntityKind,
  type EntityRecord,
  type PortableComponent,
  type TaskComment,
} from "@relay/contracts";
import { ProjectDatabase } from "../../src/database/project-database";
import { portableAggregateVersion } from "../../src/replication/portable-version";
import {
  flushComponentVersions,
  readComponents,
  versionComponent,
} from "../../src/components/component-store";
import { readCommandVersions } from "../../src/commands/command-versions";
import { readCommandGuard, loadCommandSelection } from "../../src/commands/command-selections";
import { readCommandFacts } from "../../src/commands/command-facts";

const TIMESTAMP = "2026-10-24T12:00:00.000Z";
const PHANTOM_CASES: readonly {
  /* Имя исходного отрицательного предиката. */
  readonly name: string;
  /* Выборка, после которой конкурент добавит совпадение. */
  readonly selector: CommandSelector;
  /* Вид вставляемого конкурирующим соединением владельца. */
  readonly kind: EntityKind;
  /* Содержимое, удовлетворяющее исходно пустому предикату. */
  readonly data: Readonly<Record<string, unknown>>;
}[] = [
  {
    name: "строковое поле",
    selector: { kind: "field", entityKind: "document", field: "parentId", value: "subject" },
    kind: "document",
    data: { parentId: "subject" },
  },
  {
    name: "набор строковых значений поля",
    selector: {
      kind: "field-set",
      entityKind: "document",
      field: "parentId",
      values: ["subject", "absent"],
    },
    kind: "document",
    data: { parentId: "subject" },
  },
  {
    name: "полный выбранный вид",
    selector: { kind: "kind", entityKind: "release" },
    kind: "release",
    data: {},
  },
  {
    name: "нормализованное включение задачи",
    selector: { kind: "memberships", taskId: "subject" },
    kind: "work-plan",
    data: {
      stages: [
        {
          id: "stage",
          title: "Этап",
          summary: "",
          outcome: "",
          completionConditions: "",
          taskIds: ["subject"],
        },
      ],
    },
  },
  {
    name: "элемент нормализованного массива",
    selector: {
      kind: "array-item",
      entityKind: "task",
      arrayField: "acceptanceCriteria",
      itemField: "id",
      value: "criterion",
    },
    kind: "task",
    data: {
      acceptanceCriteria: [
        {
          id: "criterion",
          title: "Условие",
          summary: "",
          description: "",
          completed: false,
          completedAt: null,
          completedBy: null,
        },
      ],
    },
  },
  {
    name: "граф задач",
    selector: { kind: "task-graph" },
    kind: "task",
    data: { column: "ready", parentId: null, dependencies: [], acceptanceCriteria: [] },
  },
];

/**
 * Создаёт реальную файловую WAL-базу и два независимых публичных соединения.
 * Raw-доступ нужен для точечных assertions технических очередей; все ресурсы удаляются в finally.
 */
async function withCommandDatabase(
  operation: (db: ProjectDatabase, peer: ProjectDatabase, raw: Database) => Promise<void>,
): Promise<void> {
  const artifacts = resolve(
    import.meta.dir,
    "../../../..",
    ".artifacts",
    new Date().toISOString().slice(0, 10),
    "git-sync-implementation/commands/review-fixes",
  );
  mkdirSync(artifacts, { recursive: true });
  const directory = mkdtempSync(join(artifacts, "fixture-"));
  const path = join(directory, "project.sqlite");
  let db: ProjectDatabase | undefined;
  let peer: ProjectDatabase | undefined;
  let raw: Database | undefined;
  try {
    db = ProjectDatabase.create(path, { id: "command-project", name: "Команды", slug: "commands" });
    peer = ProjectDatabase.open(path);
    raw = new Database(path, { create: false, readwrite: true, strict: true });
    raw.exec("PRAGMA foreign_keys=ON");
    await operation(db, peer, raw);
  } finally {
    raw?.close();
    peer?.close();
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Готовит минимальную техническую карточку для проверки порта, минуя предметные сервисы.
 * Тесты проверяют механизм SQLite; предметные валидаторы не являются частью этой подготовки.
 */
function record(
  key: string,
  kind: EntityKind = "document",
  data: Readonly<Record<string, unknown>> = {},
): EntityRecord {
  return {
    id: `id-${key}`,
    key,
    kind,
    revision: 1,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    createdBy: "author",
    updatedBy: "author",
    data: structuredClone(data),
  };
}

/**
 * Создаёт конкретный подготовленный after без чтения свежей ревизии из БД.
 */
function changed(
  before: EntityRecord,
  data: Readonly<Record<string, unknown>>,
  key = before.key,
): EntityRecord {
  return {
    ...before,
    key,
    revision: before.revision + 1,
    updatedBy: "editor",
    data: { ...before.data, ...structuredClone(data) },
  };
}

/**
 * Создаёт независимую неизменяемую запись журнала с известным ID.
 */
function comment(id: string): TaskComment {
  return { id, title: "", body: `Сообщение ${id}`, createdAt: TIMESTAMP, createdBy: "commenter" };
}

/**
 * Возвращает минимальный результат pure finalize; сохранённые эффекты проверяются отдельно в SQLite.
 */
function result(
  status: BatchResult["status"] = "committed",
  operationKey: string | null = null,
): BatchResult {
  return { operationKey, status, replayed: false, items: [], entities: [] };
}

/**
 * Описывает одну command boundary с точными effects, не переисполняемую предметным сервисом.
 */
function transition(effects: readonly CommandEffect[], index = 0): CommandTransition {
  return {
    index,
    operation: "fixture.write",
    actor: "author",
    timestamp: TIMESTAMP,
    reads: [],
    guards: [],
    predicates: [],
    targets: { primaryId: null, ownerIds: [], roles: {} },
    effects,
  };
}

/**
 * Собирает явный план проверяемой записи; overrides задают только существенные условия сценария.
 */
function plan(
  db: ProjectDatabase,
  effects: readonly CommandEffect[] = [],
  guards: readonly CommandGuard[] = [],
  overrides: Partial<CommandCommitPlan> = {},
): CommandCommitPlan {
  return {
    projectId: db.projectId,
    replicaId: db.getReplicationGuard().replicaId,
    actor: "author",
    timestamp: TIMESTAMP,
    check: false,
    guards,
    transitions: [transition(effects)],
    counters: [],
    receipt: null,
    commentTaskIds: [],
    freshTaskIds: [],
    finalize: () => result(),
    ...overrides,
  };
}

/**
 * Проверяет конкретный код отказа Promise, не принимая TypeError или успешный исход за конфликт.
 */
async function expectCommandError(operation: Promise<unknown>, code: string): Promise<void> {
  let failure: unknown;
  try {
    await operation;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(RelayError);
  if (!(failure instanceof RelayError)) {
    throw new Error("Ожидалась ошибка RelayError", { cause: failure });
  }
  expect(failure.code).toBe(code);
}

/**
 * Читает обязательную тестовую карточку, отличая отсутствие от пустого содержания.
 */
function stored(db: ProjectDatabase, id: string): EntityRecord {
  const value = db.get(id);
  if (value === undefined) {
    throw new Error(`Отсутствует подготовленная карточка ${id}`);
  }
  return value;
}

/**
 * Возвращает реально сохранённое новое назначение зависимости из последнего atomic outbox.
 * Отсутствие или tombstone явно проваливают тест, не превращаясь в равные undefined IDs.
 */
function latestDependency(
  db: ProjectDatabase,
  ownerId: string,
): PortableComponent<"task-dependency"> {
  const component = db
    .getReplicationOutbox()
    .at(-1)
    ?.components?.find(
      (change) =>
        change.after.ownerId === ownerId &&
        change.after.kind === "task-dependency" &&
        !change.after.deleted,
    )?.after;
  if (component?.kind !== "task-dependency") {
    throw new Error(`Отсутствует новое назначение зависимости ${ownerId}`);
  }
  return component;
}

/**
 * Требует metadata выбранного полного агрегата; отсутствие не подменяется локальной revision.
 */
function loadedVersions(loaded: CommandLoadResult, id: string, index = 0): CommandEntityVersions {
  const observation = loaded.observations[index];
  const versions = observation?.kind === "records" ? observation.versions?.[id] : undefined;
  if (versions === undefined) {
    throw new Error(`Отсутствуют переносимые версии загруженного владельца ${id}`);
  }
  return versions;
}

describe("Async CommandStore на реальной SQLite", () => {
  test.each(PHANTOM_CASES)(
    "phantom: $name отклоняет stale plan до любых записей",
    async ({ selector, kind, data }) => {
      await withCommandDatabase(async (db, peer, raw) => {
        const loaded = await db.commands.load({ anchor: null, selectors: [selector] });
        const draft = record("DRAFT-1");
        const prepared = plan(db, [{ kind: "entity", before: null, after: draft }], loaded.guards, {
          counters: [{ prefix: "DRAFT", before: 0, after: 1 }],
          receipt: { operationKey: "stale", requestJson: "{}" },
        });
        // Завершённый load — явный барьер: конкурент пишет до начала commit, без sleep/retry.
        peer.insert(record("PHANTOM", kind, data));
        const generation = db.getGeneration();
        const outbox = db.getReplicationOutbox();

        await expectCommandError(db.commands.commit(prepared), "COMMAND_CONTEXT_CHANGED");

        expect(db.get(draft.id)).toBeUndefined();
        expect(db.getBatchReceipt("stale")).toBeUndefined();
        expect(raw.query("SELECT value FROM key_counters WHERE prefix='DRAFT'").get()).toBeNull();
        expect(db.getGeneration()).toBe(generation);
        expect(db.getReplicationOutbox()).toEqual(outbox);
      });
    },
  );

  test("field guard замечает изменение ревизии уже выбранного состава", async () => {
    await withCommandDatabase(async (db, peer) => {
      const original = record("DOC", "document", { owner: "selected", body: "До" });
      db.insert(original);
      const loaded = await db.commands.load({
        anchor: null,
        selectors: [{ kind: "field", entityKind: "document", field: "owner", value: "selected" }],
      });
      const actual = changed(original, { body: "Конкурент" });
      peer.update(actual, original.revision);

      await expectCommandError(
        db.commands.commit(plan(db, [], loaded.guards)),
        "COMMAND_CONTEXT_CHANGED",
      );

      expect(stored(db, original.id)).toEqual(actual);
    });
  });

  test("anchor не смешивает загрузки после независимой записи и переживает reopen", async () => {
    await withCommandDatabase(async (db, peer) => {
      const loaded = await db.commands.load({ anchor: null, selectors: [] });
      const reopened = await peer.commands.load({ anchor: loaded.anchor, selectors: [] });
      expect(reopened.anchor).toEqual(loaded.anchor);
      peer.nextKey("RESERVED");

      await expectCommandError(
        db.commands.load({ anchor: loaded.anchor, selectors: [] }),
        "COMMAND_CONTEXT_CHANGED",
      );

      const fresh = await db.commands.load({ anchor: null, selectors: [] });
      expect(fresh.anchor.replicaId).toBe(loaded.anchor.replicaId);
      expect(fresh.anchor.revision).toBeGreaterThan(loaded.anchor.revision);
    });
  });

  test.each(["comment", "receipt", "remapped", "component-version", "entity-version"])(
    "anchor учитывает отдельный источник %s",
    async (source) => {
      await withCommandDatabase(async (db, peer, raw) => {
        const task = record("TASK", "task", { dependencies: [] });
        db.insert(task);
        const loaded = await db.commands.load({ anchor: null, selectors: [] });
        if (source === "comment") {
          peer.appendTaskComment(task.id, comment("new-comment"));
        } else if (source === "receipt") {
          peer.insertBatchReceipt({ operationKey: "receipt", requestJson: "{}", resultJson: "{}" });
        } else if (source === "remapped") {
          raw
            .query("INSERT INTO replication_remapped_refs VALUES(?,?,?)")
            .run("TASK", "previous", task.id);
        } else if (source === "component-version") {
          raw
            .query(
              "UPDATE entity_components SET version='changed' WHERE owner_id=? AND kind='collection'",
            )
            .run(task.id);
        } else {
          raw
            .query("UPDATE replication_entity_versions SET version='changed' WHERE entity_id=?")
            .run(task.id);
        }

        await expectCommandError(
          db.commands.load({ anchor: loaded.anchor, selectors: [] }),
          "COMMAND_CONTEXT_CHANGED",
        );
      });
    },
  );

  test("address-state guard замечает новую защиту переназначения без изменения entity CAS", async () => {
    await withCommandDatabase(async (db, _peer, raw) => {
      const original = record("TASK", "task");
      db.insert(original);
      const loaded = await db.commands.load({
        anchor: null,
        selectors: [{ kind: "address-state", ref: "TASK" }],
      });
      raw
        .query("INSERT INTO replication_remapped_refs VALUES(?,?,?)")
        .run("TASK", "old-id", original.id);

      await expectCommandError(
        db.commands.commit(
          plan(
            db,
            [
              {
                kind: "entity",
                before: original,
                after: changed(original, { title: "Неверная цель" }),
              },
            ],
            loaded.guards,
          ),
        ),
        "COMMAND_CONTEXT_CHANGED",
      );

      expect(stored(db, original.id).revision).toBe(1);
    });
  });

  test("preview пропускает ID, alias, virtual и excluded без потребления counter", async () => {
    await withCommandDatabase(async (db, _peer, raw) => {
      const alias = record("KEY-1");
      db.insert(alias);
      db.rename(alias.id, "RENAMED", 1, "author");
      db.insert({ ...record("OTHER"), id: "KEY-2" });
      db.insert(record("BOARD-A", "board", { slug: "KEY-3", prefix: "KEY-4" }));
      const anchor = await db.commands.load({ anchor: null, selectors: [] });
      const generation = db.getGeneration();
      const outbox = db.getReplicationOutbox();

      const preview = await db.commands.load({
        anchor: anchor.anchor,
        selectors: [
          { kind: "key", entityKind: "board", prefix: "KEY", after: 0, excluded: ["KEY-5"] },
        ],
      });

      expect(preview.observations).toEqual([{ kind: "key", key: "KEY-6", before: 0, value: 6 }]);
      expect(raw.query("SELECT * FROM key_counters WHERE prefix='KEY'").get()).toBeNull();
      expect((await db.commands.load({ anchor: anchor.anchor, selectors: [] })).anchor).toEqual(
        anchor.anchor,
      );
      expect(db.getGeneration()).toBe(generation);
      expect(db.getReplicationOutbox()).toEqual(outbox);
    });
  });

  test("preview начинает после max(counter, after), а commit точно сохраняет итоговый counter", async () => {
    await withCommandDatabase(async (db, _peer, raw) => {
      raw.query("INSERT INTO key_counters VALUES(?,?)").run("DOC", 4);
      const loaded = await db.commands.load({
        anchor: null,
        selectors: [
          { kind: "key", entityKind: "document", prefix: "DOC", after: 2, excluded: [] },
          { kind: "key", entityKind: "document", prefix: "DOC", after: 8, excluded: [] },
        ],
      });
      expect(loaded.observations).toEqual([
        { kind: "key", before: 4, value: 5, key: "DOC-5" },
        { kind: "key", before: 4, value: 9, key: "DOC-9" },
      ]);
      const created = record("DOC-9");

      await db.commands.commit(
        plan(db, [{ kind: "entity", before: null, after: created }], loaded.guards, {
          counters: [{ prefix: "DOC", before: 4, after: 9 }],
        }),
      );

      expect(raw.query("SELECT value FROM key_counters WHERE prefix='DOC'").get()).toEqual({
        value: 9,
      });
      expect(stored(db, created.id)).toEqual(created);
    });
  });

  test("занятый после preview ключ и отдельно stale counter отклоняются без резервирования", async () => {
    await withCommandDatabase(async (db, peer, raw) => {
      const loaded = await db.commands.load({
        anchor: null,
        selectors: [{ kind: "key", entityKind: "document", prefix: "DOC", after: 0, excluded: [] }],
      });
      peer.insert(record("DOC-1"));

      await expectCommandError(
        db.commands.commit(
          plan(db, [], loaded.guards, { counters: [{ prefix: "DOC", before: 0, after: 1 }] }),
        ),
        "COMMAND_CONTEXT_CHANGED",
      );
      expect(raw.query("SELECT value FROM key_counters WHERE prefix='DOC'").get()).toBeNull();

      peer.nextKey("DOC");
      await expectCommandError(
        db.commands.commit(
          plan(db, [], [], { counters: [{ prefix: "DOC", before: 0, after: 1 }] }),
        ),
        "COMMAND_CONTEXT_CHANGED",
      );
      expect(raw.query("SELECT value FROM key_counters WHERE prefix='DOC'").get()).toEqual({
        value: 2,
      });
    });
  });

  test("receipt-first возвращает исходный результат раньше stale guards и отличает другой request", async () => {
    await withCommandDatabase(async (db, peer) => {
      const original = record("DOC", "document", { body: "До" });
      db.insert(original);
      const loaded = await db.commands.load({
        anchor: null,
        selectors: [{ kind: "entity", ref: original.id }],
      });
      const after = changed(original, { body: "Первый результат" });
      const prepared = plan(db, [{ kind: "entity", before: original, after }], loaded.guards, {
        receipt: { operationKey: "delivery", requestJson: '{"actor":"author"}' },
        finalize: () => result("committed", "delivery"),
      });
      await db.commands.commit(prepared);
      peer.update(changed(after, { body: "Позднейшее изменение" }), 2);
      const generation = db.getGeneration();
      const outbox = db.getReplicationOutbox();
      const receipt = db.getBatchReceipt("delivery");
      if (receipt === undefined) {
        throw new Error("Первоначальная квитанция должна быть сохранена");
      }

      const replay = await db.commands.commit({
        ...prepared,
        finalize: () => {
          throw new Error("Не вызывать при replay");
        },
      });
      await expectCommandError(
        db.commands.commit({
          ...prepared,
          receipt: { operationKey: "delivery", requestJson: '{"actor":"another"}' },
        }),
        "CONFLICT",
      );

      expect(replay).toEqual({ kind: "replayed", receipt });
      expect(stored(db, original.id).data.body).toBe("Позднейшее изменение");
      expect(db.getGeneration()).toBe(generation);
      expect(db.getReplicationOutbox()).toEqual(outbox);
    });
  });

  test("check откатывает aliases, counters, journals, receipts, anchor и boundary tape", async () => {
    await withCommandDatabase(async (db, _peer, raw) => {
      const original = record("TASK", "task", { title: "Исходная", comments: [] });
      db.insert(original);
      const loaded = await db.commands.load({
        anchor: null,
        selectors: [{ kind: "entity", ref: original.id }],
      });
      const generation = db.getGeneration();
      const outbox = db.getReplicationOutbox();
      let facts: CommandCommitFacts | undefined;
      const prepared = plan(
        db,
        [
          {
            kind: "entity",
            before: original,
            after: changed(original, { title: "Проверяемая" }, "TASK-8"),
          },
          { kind: "comment", taskId: original.id, comment: comment("checked-comment") },
        ],
        loaded.guards,
        {
          check: true,
          counters: [{ prefix: "TASK", before: 0, after: 8 }],
          receipt: { operationKey: "checked-receipt", requestJson: "{}" },
          commentTaskIds: [original.id],
          finalize: (observed) => {
            facts = observed;
            return result("checked", "checked-receipt");
          },
        },
      );

      const checked = await db.commands.commit(prepared);

      expect(checked).toEqual({ kind: "checked", result: result("checked", "checked-receipt") });
      expect(facts?.comments.get(original.id)).toEqual([comment("checked-comment")]);
      expect(facts?.generation).toBe(generation + 2);
      expect(stored(db, original.id)).toEqual(original);
      expect(db.getIdentity("TASK-8")).toBeUndefined();
      expect(db.getBatchReceipt("checked-receipt")).toBeUndefined();
      expect(raw.query("SELECT * FROM key_counters WHERE prefix='TASK'").get()).toBeNull();
      expect(raw.query("SELECT * FROM replication_transition_queue").all()).toEqual([]);
      expect(db.getGeneration()).toBe(generation);
      expect(db.getReplicationOutbox()).toEqual(outbox);
      expect((await db.commands.load({ anchor: loaded.anchor, selectors: [] })).anchor).toEqual(
        loaded.anchor,
      );
    });
  });

  test.each(["async", "thenable"])(
    "%s finalize отклоняется с rollback, async body не запускается",
    async (mode) => {
      await withCommandDatabase(async (db, _peer, raw) => {
        const created = record("REJECTED-1");
        const generation = db.getGeneration();
        const outbox = db.getReplicationOutbox();
        let invoked = 0;
        const prepared = plan(db, [{ kind: "entity", before: null, after: created }], [], {
          counters: [{ prefix: "REJECTED", before: 0, after: 1 }],
          receipt: { operationKey: "rejected", requestJson: "{}" },
        });
        // Внедрение неверного runtime-контракта не маскируется утверждением TypeScript-типа.
        Reflect.set(
          prepared,
          "finalize",
          mode === "async"
            ? async () => {
                invoked++;
                return result();
              }
            : () => {
                invoked++;
                return { then: (resolve: (value: BatchResult) => void) => resolve(result()) };
              },
        );

        await expectCommandError(db.commands.commit(prepared), "ASYNC_TRANSACTION");

        expect(invoked).toBe(mode === "async" ? 0 : 1);
        expect(db.get(created.id)).toBeUndefined();
        expect(db.getBatchReceipt("rejected")).toBeUndefined();
        expect(raw.query("SELECT * FROM key_counters WHERE prefix='REJECTED'").get()).toBeNull();
        expect(raw.query("SELECT * FROM replication_transition_queue").all()).toEqual([]);
        expect(db.getGeneration()).toBe(generation);
        expect(db.getReplicationOutbox()).toEqual(outbox);
      });
    },
  );

  test("поздний CAS failure откатывает уже применённый boundary и технические резервы", async () => {
    await withCommandDatabase(async (db, peer, raw) => {
      const first = record("FIRST");
      const second = record("SECOND");
      db.insert(first);
      db.insert(second);
      const concurrent = changed(second, { body: "Конкурент" });
      peer.update(concurrent, 1);
      const generation = db.getGeneration();
      const outbox = db.getReplicationOutbox();
      const prepared = plan(db, [], [], {
        counters: [{ prefix: "CAS", before: 0, after: 1 }],
        transitions: [
          transition(
            [
              {
                kind: "entity",
                before: first,
                after: changed(first, { body: "Откатить" }, "NEW-FIRST"),
              },
            ],
            0,
          ),
          transition(
            [{ kind: "entity", before: second, after: changed(second, { body: "Устаревший" }) }],
            1,
          ),
        ],
      });

      await expectCommandError(db.commands.commit(prepared), "REVISION_CONFLICT");

      expect(stored(db, first.id)).toEqual(first);
      expect(stored(db, second.id)).toEqual(concurrent);
      expect(db.getIdentity("NEW-FIRST")).toBeUndefined();
      expect(raw.query("SELECT * FROM key_counters WHERE prefix='CAS'").get()).toBeNull();
      expect(raw.query("SELECT * FROM replication_transition_queue").all()).toEqual([]);
      expect(db.getGeneration()).toBe(generation);
      expect(db.getReplicationOutbox()).toEqual(outbox);
    });
  });

  test("два append с одним исходным guard сохраняются, старый content update не заменяет журнал", async () => {
    await withCommandDatabase(async (db, peer) => {
      const original = record("TASK", "task", { title: "До", comments: [] });
      db.insert(original);
      const selector: CommandSelector = { kind: "entity", ref: original.id, semantic: "existence" };
      // Оба участника завершили подготовку до первого commit; journal не входит в fingerprints.
      const left = await db.commands.load({ anchor: null, selectors: [selector] });
      const right = await peer.commands.load({ anchor: null, selectors: [selector] });
      let finalFacts: CommandCommitFacts | undefined;
      const leftComment = { ...comment("left"), body: "Точное содержание \ud800" };
      const leftEffect: CommandEffect = {
        kind: "comment",
        taskId: original.id,
        comment: leftComment,
      };
      const rightEffect: CommandEffect = {
        kind: "comment",
        taskId: original.id,
        comment: comment("right"),
      };

      await db.commands.commit(
        plan(db, [leftEffect], left.guards, {
          transitions: [
            {
              ...transition([leftEffect]),
              predicates: [{ selector, observation: { kind: "records", records: [original] } }],
            },
          ],
        }),
      );
      await peer.commands.commit(
        plan(peer, [rightEffect], right.guards, {
          commentTaskIds: [original.id],
          finalize: (facts) => {
            finalFacts = facts;
            return result();
          },
        }),
      );
      const commentChangeset = db.getReplicationOutbox().at(-1);
      await db.commands.commit(
        plan(
          db,
          [{ kind: "entity", before: original, after: changed(original, { title: "После" }) }],
          left.guards,
        ),
      );

      expect(finalFacts?.comments.get(original.id)).toEqual([leftComment, comment("right")]);
      expect([...(finalFacts?.comments.keys() ?? [])]).toEqual([original.id]);
      expect(stored(db, original.id)).toMatchObject({
        revision: 2,
        data: { title: "После", comments: [leftComment, comment("right")] },
      });
      expect(
        commentChangeset?.readContext
          .filter((read) => read.id === original.id)
          .map((read) => read.kind),
      ).toEqual(["existence"]);
    });
  });

  test("ordered tape сохраняет промежуточное удаление и повторное включение с новым component ID", async () => {
    await withCommandDatabase(async (db) => {
      const original = record("TASK", "task", { dependencies: ["dependency"], comments: [] });
      db.insert(original);
      const before = db
        .captureReplication()
        .components?.find(
          (part) => part.ownerId === original.id && part.kind === "task-dependency",
        );
      const removed = changed(original, { dependencies: [] });
      const readded = changed(removed, { dependencies: ["dependency"] });

      await db.commands.commit(
        plan(db, [], [], {
          transitions: [
            transition([{ kind: "entity", before: original, after: removed }], 0),
            transition([{ kind: "entity", before: removed, after: readded }], 1),
          ],
        }),
      );

      const source = db.getReplicationOutbox().at(-1);
      expect(stored(db, original.id).revision).toBe(3);
      expect(stored(db, original.id).data.dependencies).toEqual(["dependency"]);
      expect(source?.transitions).toHaveLength(2);
      const tombstone = source?.transitions?.[0]?.components.find(
        (part) => part.after.kind === "task-dependency",
      );
      const replacement = source?.transitions?.[1]?.components.find(
        (part) => part.after.kind === "task-dependency" && !part.after.deleted,
      );
      expect(before).toBeDefined();
      expect(tombstone?.after.id).toBe(before?.id);
      expect(tombstone?.after.deleted).toBe(true);
      expect(replacement).toBeDefined();
      expect(replacement?.after.id).not.toBe(before?.id);
      expect(replacement?.before).toBeNull();
    });
  });

  test("no-effect commit очищает tape без outbox, обычный load не публикует постороннюю очередь", async () => {
    await withCommandDatabase(async (db, _peer, raw) => {
      const outbox = db.getReplicationOutbox();

      await db.commands.commit(plan(db));

      expect(db.getReplicationOutbox()).toEqual(outbox);
      expect(raw.query("SELECT * FROM replication_transition_queue").all()).toEqual([]);
      const pending = {
        command: "pending",
        actor: "author",
        targets: { primaryId: null, ownerIds: [], roles: {} },
        entities: [],
        components: [],
        addresses: [],
        comments: [],
        receipts: [],
        readContext: [],
        predicates: [],
      };
      raw
        .query("INSERT INTO replication_transition_queue VALUES(?,?)")
        .run(0, JSON.stringify(pending));
      await db.commands.load({ anchor: null, selectors: [] });
      expect(raw.query("SELECT json FROM replication_transition_queue").all()).toEqual([
        { json: JSON.stringify(pending) },
      ]);
      raw.exec("DELETE FROM replication_transition_queue");
    });
  });

  test("отказ SQL не превращается в COMMAND_CONTEXT_CHANGED и не повторяет операцию", async () => {
    await withCommandDatabase(async (db, _peer, raw) => {
      raw.exec("DROP TABLE command_read_state");

      await expectCommandError(db.commands.load({ anchor: null, selectors: [] }), "STORAGE_ERROR");
    });
  });

  test("исходный отрицательный guard не перепроверяется поверх собственных промежуточных effects", async () => {
    await withCommandDatabase(async (db) => {
      const created = record("OWN", "document", { owner: "selected" });
      const loaded = await db.commands.load({
        anchor: null,
        selectors: [{ kind: "field", entityKind: "document", field: "owner", value: "selected" }],
      });
      const updated = changed(created, { body: "Второй шаг" });
      const steps = [
        transition([{ kind: "entity", before: null, after: created }], 0),
        transition([{ kind: "entity", before: created, after: updated }], 1),
      ].map((step) => ({ ...step, guards: loaded.guards }));

      const committed = await db.commands.commit(
        plan(db, [], loaded.guards, { transitions: steps }),
      );

      expect(committed.kind).toBe("committed");
      expect(stored(db, created.id)).toEqual(updated);
      expect(db.getReplicationOutbox().at(-1)?.transitions).toHaveLength(2);
    });
  });

  test("исчерпание безопасных номеров конечно и отличает stale preview от нового запроса", async () => {
    await withCommandDatabase(async (db, _peer, raw) => {
      const selector: CommandSelector = {
        kind: "key",
        entityKind: "document",
        prefix: "LIMIT",
        after: Number.MAX_SAFE_INTEGER - 1,
        excluded: [],
      };
      const loaded = await db.commands.load({ anchor: null, selectors: [selector] });
      expect(loaded.observations).toEqual([
        {
          kind: "key",
          key: `LIMIT-${Number.MAX_SAFE_INTEGER}`,
          before: 0,
          value: Number.MAX_SAFE_INTEGER,
        },
      ]);
      raw.query("INSERT INTO key_counters VALUES(?,?)").run("LIMIT", Number.MAX_SAFE_INTEGER);

      await expectCommandError(
        db.commands.commit(plan(db, [], loaded.guards)),
        "COMMAND_CONTEXT_CHANGED",
      );
      await expectCommandError(
        db.commands.load({ anchor: null, selectors: [selector] }),
        "CONFLICT",
      );

      expect(raw.query("SELECT value FROM key_counters WHERE prefix='LIMIT'").get()).toEqual({
        value: Number.MAX_SAFE_INTEGER,
      });
    });
  });

  test("receipt-only boundary сохраняет явные targets даже без entity effects", async () => {
    await withCommandDatabase(async (db) => {
      const targets = {
        primaryId: "read-owner",
        ownerIds: ["read-owner", "second-owner"],
        roles: { ref: "read-owner", "input.targetPlan": "second-owner", "input.stageId": null },
      };

      await db.commands.commit(
        plan(db, [], [], {
          transitions: [{ ...transition([]), targets }],
          receipt: { operationKey: "noop-targets", requestJson: "{}" },
        }),
      );

      expect(db.getReplicationOutbox().at(-1)?.transitions?.[0]?.targets).toEqual(targets);
      expect(db.getBatchReceipt("noop-targets")?.requestJson).toBe("{}");
    });
  });

  test("инфраструктурный отказ outer outbox откатывает уже рассчитанный результат и receipt", async () => {
    await withCommandDatabase(async (db, _peer, raw) => {
      const created = record("ATOMIC-1");
      const generation = db.getGeneration();
      const outbox = db.getReplicationOutbox();
      const anchor = await db.commands.load({ anchor: null, selectors: [] });
      let finalized = 0;
      // Ошибка разрешается SQLite при INSERT outbox, после effects/finalize/receipt порта.
      raw.exec(`CREATE TRIGGER command_test_outbox_failure BEFORE INSERT ON replication_outbox BEGIN
        INSERT INTO missing_command_fixture VALUES(NEW.id);
      END`);
      const prepared = plan(db, [{ kind: "entity", before: null, after: created }], [], {
        counters: [{ prefix: "ATOMIC", before: 0, after: 1 }],
        receipt: { operationKey: "atomic-receipt", requestJson: "{}" },
        finalize: () => {
          finalized++;
          return result("committed", "atomic-receipt");
        },
      });

      await expectCommandError(db.commands.commit(prepared), "STORAGE_ERROR");

      expect(finalized).toBe(1);
      expect(db.get(created.id)).toBeUndefined();
      expect(db.getIdentity(created.key)).toBeUndefined();
      expect(db.getBatchReceipt("atomic-receipt")).toBeUndefined();
      expect(raw.query("SELECT * FROM key_counters WHERE prefix='ATOMIC'").get()).toBeNull();
      expect(raw.query("SELECT * FROM replication_transition_queue").all()).toEqual([]);
      expect(db.getGeneration()).toBe(generation);
      expect(db.getReplicationOutbox()).toEqual(outbox);
      expect((await db.commands.load({ anchor: anchor.anchor, selectors: [] })).anchor).toEqual(
        anchor.anchor,
      );
      raw.exec("DROP TRIGGER command_test_outbox_failure");
    });
  });

  test("одинаковые offline переходы одного проекта получают разные ID назначений на разных репликах", async () => {
    await withCommandDatabase(async (left) => {
      await withCommandDatabase(async (right) => {
        const original = record("SHARED", "task", { dependencies: [], comments: [] });
        left.insert(original);
        right.insert(original);
        const leftRead = await left.commands.load({
          anchor: null,
          selectors: [{ kind: "entity", ref: original.id }],
        });
        const rightRead = await right.commands.load({
          anchor: null,
          selectors: [{ kind: "entity", ref: original.id }],
        });
        const after = changed(original, { dependencies: ["dependency"] });
        const prepared = plan(
          left,
          [{ kind: "entity", before: original, after }],
          leftRead.guards,
          { replicaId: leftRead.anchor.replicaId },
        );
        // Allocation-входы совпадают; guards защищают собственные части исходного состояния реплики.
        const remotePlan = {
          ...prepared,
          replicaId: rightRead.anchor.replicaId,
          guards: rightRead.guards,
        };
        expect(left.projectId).toBe(right.projectId);
        expect(leftRead.anchor.replicaId).not.toBe(rightRead.anchor.replicaId);

        await left.commands.commit(prepared);
        await right.commands.commit(remotePlan);

        const leftPart = latestDependency(left, original.id);
        const rightPart = latestDependency(right, original.id);
        expect(leftPart.value).toEqual({ taskId: "dependency" });
        expect(rightPart.value).toEqual(leftPart.value);
        expect(leftPart.id).not.toBe(rightPart.id);
        expect(stored(left, original.id)).toEqual(after);
        expect(stored(right, original.id)).toEqual(after);
      });
    });
  });

  test("один подготовленный план воспроизводит ID и версию назначения на точной копии той же реплики", async () => {
    await withCommandDatabase(async (db, _peer, raw) => {
      const original = record("SAME-PLAN", "task", { dependencies: [], comments: [] });
      db.insert(original);
      const loaded = await db.commands.load({
        anchor: null,
        selectors: [{ kind: "entity", ref: original.id }],
      });
      const prepared = plan(
        db,
        [
          {
            kind: "entity",
            before: original,
            after: changed(original, { dependencies: ["dependency"] }),
          },
        ],
        loaded.guards,
        { replicaId: loaded.anchor.replicaId },
      );
      const copyPath = join(dirname(db.path), "same-replica.sqlite");
      // VACUUM INTO сохраняет весь before-state, включая replicaId и прежние component IDs.
      raw.query("VACUUM INTO ?").run(copyPath);
      const copy = ProjectDatabase.open(copyPath);
      try {
        expect((await copy.commands.load({ anchor: loaded.anchor, selectors: [] })).anchor).toEqual(
          loaded.anchor,
        );

        await db.commands.commit(prepared);
        await copy.commands.commit(prepared);

        expect(latestDependency(copy, original.id)).toEqual(latestDependency(db, original.id));
        expect(stored(copy, original.id)).toEqual(stored(db, original.id));
      } finally {
        copy.close();
      }
    });
  });

  test.each([false, true])(
    "план чужой реплики отклоняется до guards и receipt replay=%s",
    async (hasReceipt) => {
      await withCommandDatabase(async (source) => {
        await withCommandDatabase(async (destination, _peer, raw) => {
          const created = record("FOREIGN-1");
          const loaded = await source.commands.load({ anchor: null, selectors: [] });
          const receipt = {
            operationKey: "foreign",
            requestJson: "{}",
            resultJson: JSON.stringify(result("committed", "foreign")),
          };
          if (hasReceipt) {
            destination.insertBatchReceipt(receipt);
          }
          const generation = destination.getGeneration();
          const outbox = destination.getReplicationOutbox();
          const before = await destination.commands.load({ anchor: null, selectors: [] });
          const prepared = plan(source, [{ kind: "entity", before: null, after: created }], [], {
            replicaId: loaded.anchor.replicaId,
            counters: [{ prefix: "FOREIGN", before: 0, after: 1 }],
            receipt: hasReceipt ? receipt : null,
          });

          await expectCommandError(destination.commands.commit(prepared), "REPLICA_MISMATCH");

          expect(destination.projectId).toBe(source.projectId);
          expect(destination.get(created.id)).toBeUndefined();
          expect(destination.getBatchReceipt("foreign")).toEqual(hasReceipt ? receipt : undefined);
          expect(raw.query("SELECT * FROM key_counters WHERE prefix='FOREIGN'").get()).toBeNull();
          expect(raw.query("SELECT * FROM replication_transition_queue").all()).toEqual([]);
          expect(destination.getGeneration()).toBe(generation);
          expect(destination.getReplicationOutbox()).toEqual(outbox);
          expect(
            (await destination.commands.load({ anchor: before.anchor, selectors: [] })).anchor,
          ).toEqual(before.anchor);
        });
      });
    },
  );

  test("все полные selectors возвращают версии только выбранных агрегатов отдельно от EntityRecord", async () => {
    await withCommandDatabase(async (db) => {
      const selected = record("VERSIONED", "work-plan", {
        projectId: db.projectId,
        stages: [
          {
            id: "stage",
            title: "Этап",
            summary: "",
            outcome: "",
            completionConditions: "",
            taskIds: ["subject"],
          },
        ],
      });
      const other = record("OTHER", "work-plan", { projectId: db.projectId, stages: [] });
      db.insert(selected);
      db.insert(other);
      const snapshot = db.captureReplication();
      const selectors: readonly CommandSelector[] = [
        { kind: "entity", ref: selected.key },
        { kind: "records", ids: [other.id, selected.id, other.id, "missing"] },
        { kind: "field", entityKind: "work-plan", field: "projectId", value: db.projectId },
        { kind: "kind", entityKind: "work-plan" },
        { kind: "memberships", taskId: "subject" },
        { kind: "field", entityKind: "work-plan", field: "projectId", value: "missing" },
      ];

      const loaded = await db.commands.load({ anchor: null, selectors });

      for (const [index, observation] of loaded.observations.entries()) {
        expect(observation.kind).toBe("records");
        if (observation.kind !== "records") {
          throw new Error("Ожидалось наблюдение полных записей");
        }
        expect(Object.keys(observation.versions ?? {}).sort()).toEqual(
          [...new Set(observation.records.map((entry) => entry.id))].sort(),
        );
        for (const entry of observation.records) {
          const primary = snapshot.entities.find((entity) => entity.record.id === entry.id);
          if (primary === undefined) {
            throw new Error("Отсутствует подготовленная первичная запись");
          }
          expect(loadedVersions(loaded, entry.id, index)).toEqual({
            recordVersion: primary.version,
            aggregateVersion: portableAggregateVersion(primary, snapshot.components ?? []),
          });
          expect(entry).not.toHaveProperty("recordVersion");
          expect(entry).not.toHaveProperty("aggregateVersion");
        }
      }
    });
  });

  test("versions читаются пакетно для нескольких выбранных owners без запроса на каждого", async () => {
    await withCommandDatabase(async (db, _peer, raw) => {
      const owners = [record("ONE"), record("TWO"), record("THREE")];
      db.transaction(() => {
        for (const owner of owners) {
          db.insert(owner);
        }
      });
      const ids = owners.map((owner) => owner.id);
      const query = spyOn(raw, "query");
      try {
        const versions = readCommandVersions(raw, [...ids, ids[0] ?? ""]);

        expect(Object.keys(versions).sort()).toEqual([...ids].sort());
        expect(query.mock.calls.length).toBeLessThanOrEqual(2);
        expect(versions[ids[0] ?? ""]?.aggregateVersion).toMatch(/^[a-f0-9]{64}$/);
      } finally {
        query.mockRestore();
      }
    });
  });

  test("component-only изменение меняет aggregate guard при прежних primary version и local revision", async () => {
    await withCommandDatabase(async (db, _peer, raw) => {
      const original = record("COMPONENT", "task", {
        comments: [],
        acceptanceCriteria: [
          {
            id: "criterion",
            title: "До",
            summary: "",
            description: "",
            completed: false,
            completedAt: null,
            completedBy: null,
          },
        ],
      });
      db.insert(original);
      const selector: CommandSelector = { kind: "entity", ref: original.id };
      const loaded = await db.commands.load({ anchor: null, selectors: [selector] });
      const before = loadedVersions(loaded, original.id);
      const criterion = readComponents(raw, [original.id]).find(
        (part) => part.kind === "task-criterion",
      );
      if (criterion?.kind !== "task-criterion") {
        throw new Error("Отсутствует подготовленный критерий");
      }
      const changedPart = versionComponent({
        ...criterion,
        parents: [criterion.version],
        value: { ...criterion.value, title: "Конкурентное изменение" },
      });
      // Низкая запись намеренно оставляет owner CAS прежним, изолируя проверку aggregate token.
      raw
        .query(
          "UPDATE entity_components SET value=?,version=?,parents_json=? WHERE owner_id=? AND kind=? AND id=?",
        )
        .run(
          JSON.stringify(changedPart.value),
          changedPart.version,
          JSON.stringify(changedPart.parents),
          changedPart.ownerId,
          changedPart.kind,
          changedPart.id,
        );

      const current = await db.commands.load({ anchor: null, selectors: [selector] });
      await expectCommandError(
        db.commands.commit(
          plan(
            db,
            [
              {
                kind: "entity",
                before: original,
                after: changed(original, { title: "Устаревшая запись" }),
              },
            ],
            loaded.guards,
          ),
        ),
        "COMMAND_CONTEXT_CHANGED",
      );

      const after = loadedVersions(current, original.id);
      expect(after.recordVersion).toBe(before.recordVersion);
      expect(after.aggregateVersion).not.toBe(before.aggregateVersion);
      expect(stored(db, original.id)).toMatchObject({
        revision: original.revision,
        data: { acceptanceCriteria: [{ id: "criterion", title: "Конкурентное изменение" }] },
      });
      expect(stored(db, original.id).data).not.toHaveProperty("title");
    });
  });

  test.each(["task-dependency", "address-assignment", "collection"] as const)(
    "aggregate token учитывает сохранённую часть %s, включая tombstone",
    async (kind) => {
      await withCommandDatabase(async (db, _peer, raw) => {
        const original = record("ALL-PARTS", "task", { dependencies: ["retired"], comments: [] });
        db.insert(original);
        db.update(changed(original, { dependencies: [] }), 1);
        const selector: CommandSelector = { kind: "entity", ref: original.id };
        const loaded = await db.commands.load({ anchor: null, selectors: [selector] });
        const part = readComponents(raw, [original.id]).find((entry) => entry.kind === kind);
        if (part === undefined) {
          throw new Error("Отсутствует подготовленная часть агрегата");
        }
        if (kind === "task-dependency") {
          expect(part.deleted).toBe(true);
        }
        const changedPart = versionComponent({ ...part, parents: [part.version] });
        raw
          .query(
            "UPDATE entity_components SET version=?,parents_json=? WHERE owner_id=? AND kind=? AND id=?",
          )
          .run(
            changedPart.version,
            JSON.stringify(changedPart.parents),
            part.ownerId,
            part.kind,
            part.id,
          );

        const current = await db.commands.load({ anchor: null, selectors: [selector] });

        expect(loadedVersions(current, original.id).recordVersion).toBe(
          loadedVersions(loaded, original.id).recordVersion,
        );
        expect(loadedVersions(current, original.id).aggregateVersion).not.toBe(
          loadedVersions(loaded, original.id).aggregateVersion,
        );
      });
    },
  );

  test("комментарии и техническая local revision не меняют portable aggregate token", async () => {
    await withCommandDatabase(async (db, peer, raw) => {
      const original = record("PORTABLE", "task", { dependencies: [], comments: [] });
      db.insert(original);
      const selector: CommandSelector = { kind: "entity", ref: original.id };
      const before = await db.commands.load({ anchor: null, selectors: [selector] });
      peer.appendTaskComment(original.id, comment("independent"));
      // Технический import меняет лишь local CAS; portable owner и parts остаются прежними.
      raw
        .transaction(() => {
          raw.exec("UPDATE replication_state SET importing=1 WHERE singleton=1");
          raw.query("UPDATE entities SET revision=revision+1 WHERE id=?").run(original.id);
          raw.exec("UPDATE replication_state SET importing=0 WHERE singleton=1");
        })
        .immediate();

      const after = await db.commands.load({ anchor: null, selectors: [selector] });

      expect(loadedVersions(after, original.id)).toEqual(loadedVersions(before, original.id));
      expect(after.guards[0]?.fingerprint).not.toBe(before.guards[0]?.fingerprint);
      expect(stored(db, original.id)).toMatchObject({
        revision: 2,
        data: { comments: [comment("independent")] },
      });
    });
  });

  test("summaries сохраняет адресное окно и metadata, не декодируя payload частей", async () => {
    await withCommandDatabase(async (db, _peer, raw) => {
      const task = record("SUMMARY-TASK", "task", {
        title: "Задача",
        column: "ready",
        description: "Полное описание",
        comments: [],
        acceptanceCriteria: [
          {
            id: "criterion",
            title: "Условие",
            summary: "",
            description: "",
            completed: false,
            completedAt: null,
            completedBy: null,
          },
        ],
      });
      const document = record("SUMMARY-DOC", "document", {
        name: "Документ",
        documentStatus: "draft",
        body: "Полный документ",
      });
      db.insert(task);
      db.insert(document);
      db.insert(record("OUTSIDE", "document", { name: "Вне выбранного окна" }));
      const versions = readCommandVersions(raw, [task.id, document.id]);
      // Полная гидратация этой карточки должна отказать; summary не использует содержимое критерия.
      raw
        .query(
          "UPDATE entity_components SET value=json_set(value,'$.title',123) WHERE owner_id=? AND kind='task-criterion'",
        )
        .run(task.id);

      const loaded = await db.commands.load({
        anchor: null,
        selectors: [
          { kind: "summaries", ids: [document.id, "missing", task.id, document.id] },
          { kind: "summaries", ids: [] },
        ],
      });

      const documentSummary = {
        id: document.id,
        kind: document.kind,
        key: document.key,
        revision: 1,
        title: "Документ",
        state: "draft",
        active: undefined,
      };
      expect(loaded.observations).toEqual([
        {
          kind: "summaries",
          summaries: [
            documentSummary,
            null,
            {
              id: task.id,
              kind: task.kind,
              key: task.key,
              revision: 1,
              title: "Задача",
              state: "ready",
              active: undefined,
            },
            documentSummary,
          ],
          versions,
        },
        { kind: "summaries", summaries: [], versions: {} },
      ]);
      expect(loaded.generation).toBe(db.getGeneration());
      // Даже повторная проверка summary guard использует только row metadata и версии частей.
      const guard = loaded.guards[0];
      if (guard === undefined) {
        throw new Error("Отсутствует guard summary-выборки");
      }
      const actual = raw.transaction(() => readCommandGuard(raw, guard.selector)).deferred();
      expect(actual.fingerprint).toBe(guard.fingerprint);
      await expectCommandError(
        db.commands.load({ anchor: null, selectors: [{ kind: "entity", ref: task.id }] }),
        "CORRUPT_DATA",
      );
    });
  });

  test("summaries и generation принадлежат snapshot до конкурентного commit и не подменяются anchor revision", async () => {
    await withCommandDatabase(async (db, peer, raw) => {
      const original = record("SNAPSHOT-SUMMARY", "document", {
        name: "Исходное имя",
        documentStatus: "draft",
      });
      db.insert(original);
      peer.nextKey("ANCHOR-ONLY");
      const generation = db.getGeneration();
      const versions = readCommandVersions(raw, [original.id]);
      const snapshot = db.snapshot.bind(db);
      const barrier = spyOn(db, "snapshot").mockImplementation((operation) =>
        snapshot(() => {
          const selected = operation();
          // Писатель фиксирует изменение после SQL чтений, но до возврата load из host snapshot.
          peer.update(changed(original, { name: "Новое имя" }), original.revision);
          return selected;
        }),
      );
      let loaded: CommandLoadResult;
      try {
        loaded = await db.commands.load({
          anchor: null,
          selectors: [{ kind: "summaries", ids: [original.id] }],
        });
      } finally {
        barrier.mockRestore();
      }

      expect(loaded.generation).toBe(generation);
      expect(loaded.generation).not.toBe(loaded.anchor.revision);
      expect(loaded.observations).toEqual([
        {
          kind: "summaries",
          summaries: [
            {
              id: original.id,
              kind: original.kind,
              key: original.key,
              revision: 1,
              title: "Исходное имя",
              state: "draft",
              active: undefined,
            },
          ],
          versions,
        },
      ]);
      expect(db.getGeneration()).toBe(generation + 1);
      expect(stored(db, original.id).data.name).toBe("Новое имя");
    });
  });

  test("existence guards допускают комментарий после content edit и rename, facts возвращают свежую задачу", async () => {
    await withCommandDatabase(async (db, peer) => {
      const original = record("OLD-TASK", "task", { title: "До", dependencies: [], comments: [] });
      db.insert(original);
      db.insert(record("UNSELECTED-TASK", "task", { title: "Чужая задача", comments: [] }));
      const selector: CommandSelector = {
        kind: "entity",
        ref: original.key,
        entityKind: "task",
        semantic: "existence",
      };
      const loaded = await db.commands.load({
        anchor: null,
        selectors: [
          selector,
          { kind: "identities", refs: [original.id, original.key] },
          { kind: "address-state", ref: original.key },
        ],
      });
      const entry = comment("after-edit");
      const effect: CommandEffect = { kind: "comment", taskId: original.id, comment: entry };
      let facts: CommandCommitFacts | undefined;
      const prepared = plan(db, [effect], loaded.guards, {
        freshTaskIds: [original.id],
        commentTaskIds: [original.id],
        transitions: [
          {
            ...transition([effect]),
            reads: [original],
            predicates: [{ selector, observation: { kind: "records", records: [original] } }],
          },
        ],
        finalize: (current) => {
          facts = current;
          return result();
        },
      });
      const edited = changed(original, { title: "Конкурентное содержание" }, "RENAMED-TASK");
      peer.update(edited, original.revision);
      const contentChange = peer.getReplicationOutbox().at(-1);
      if (contentChange === undefined) {
        throw new Error("Отсутствует changeset конкурентной правки");
      }

      await db.commands.commit(prepared);

      const current = { ...edited, data: { ...edited.data, comments: [entry] } };
      expect(stored(db, original.id)).toEqual(current);
      expect(facts?.taskRecords.get(original.id)).toEqual(current);
      expect([...(facts?.taskRecords.keys() ?? [])]).toEqual([original.id]);
      expect(facts?.comments.get(original.id)).toEqual([entry]);
      expect(db.getIdentity(original.key)?.id).toBe(original.id);
      const append = db.getReplicationOutbox().at(-1);
      expect(
        append?.readContext.filter((read) => read.id === original.id).map((read) => read.kind),
      ).toEqual(["existence"]);
      expect(append?.dependencies).not.toContain(contentChange.id);
    });
  });

  test.each(["entity", "identities"] as const)(
    "existence %s guard отклоняет новую привязку прежнего alias",
    async (kind) => {
      await withCommandDatabase(async (db, _peer, raw) => {
        const original = record("OLD-ALIAS", "task", { comments: [] });
        const other = record("OTHER-TASK", "task", { comments: [] });
        db.insert(original);
        db.insert(other);
        db.rename(original.id, "PRIMARY-TASK", original.revision, "author");
        const selector: CommandSelector =
          kind === "entity"
            ? { kind, ref: original.key, semantic: "existence", entityKind: "task" }
            : { kind, refs: [original.key] };
        const loaded = await db.commands.load({ anchor: null, selectors: [selector] });
        // Техническая переназначенная привязка не меняет ID/вид двух владельцев.
        raw
          .transaction(() => {
            raw.exec("UPDATE replication_state SET importing=1 WHERE singleton=1");
            raw.query("DELETE FROM entity_refs WHERE ref=?").run(original.key);
            raw
              .query("INSERT INTO entity_refs(ref,entity_id) VALUES(?,?)")
              .run(original.key, other.id);
            flushComponentVersions(raw);
            raw.exec("UPDATE replication_state SET importing=0 WHERE singleton=1");
          })
          .immediate();

        await expectCommandError(
          db.commands.commit(
            plan(
              db,
              [{ kind: "comment", taskId: original.id, comment: comment("stale-alias") }],
              loaded.guards,
              { freshTaskIds: [original.id], commentTaskIds: [original.id] },
            ),
          ),
          "COMMAND_CONTEXT_CHANGED",
        );

        expect(db.getIdentity(original.key)?.id).toBe(other.id);
        expect(stored(db, original.id).data.comments).toEqual([]);
        expect(stored(db, other.id).data.comments).toEqual([]);
      });
    },
  );

  test.each(["missing-comment", "content-effect"] as const)(
    "freshTaskIds отклоняет %s без записи комментария или содержания",
    async (mode) => {
      await withCommandDatabase(async (db) => {
        const original = record("FRESH-CONTRACT", "task", { title: "До", comments: [] });
        db.insert(original);
        const generation = db.getGeneration();
        const outbox = db.getReplicationOutbox();
        const transitions =
          mode === "missing-comment"
            ? [transition([])]
            : [
                transition(
                  [{ kind: "comment", taskId: original.id, comment: comment("invalid-refresh") }],
                  0,
                ),
                transition(
                  [
                    {
                      kind: "entity",
                      before: original,
                      after: changed(original, { title: "Не сохранять" }),
                    },
                  ],
                  1,
                ),
              ];

        await expectCommandError(
          db.commands.commit(
            plan(db, [], [], {
              transitions,
              freshTaskIds: [original.id],
              commentTaskIds: [original.id],
            }),
          ),
          "VALIDATION_ERROR",
        );

        expect(stored(db, original.id)).toEqual(original);
        expect(db.getGeneration()).toBe(generation);
        expect(db.getReplicationOutbox()).toEqual(outbox);
      });
    },
  );

  test("freshTaskIds переиспользует журнал из карточек без повторной SQL-выборки комментариев", async () => {
    await withCommandDatabase(async (db, _peer, raw) => {
      const first = record("FRESH-FIRST", "task", { title: "Первый", comments: [] });
      const second = record("FRESH-SECOND", "task", { title: "Второй", comments: [] });
      db.insert(first);
      db.insert(second);
      db.appendTaskComment(first.id, comment("first-journal"));
      db.appendTaskComment(second.id, comment("second-journal"));
      raw.exec("BEGIN DEFERRED");
      const query = spyOn(raw, "query");
      try {
        const facts = readCommandFacts(raw, [first.id, second.id], [first.id, second.id, first.id]);

        expect([...facts.taskRecords.keys()]).toEqual([first.id, second.id]);
        expect(facts.comments.get(first.id)).toEqual([comment("first-journal")]);
        expect(facts.comments.get(second.id)).toEqual([comment("second-journal")]);
        expect(query.mock.calls.filter(([sql]) => sql.includes("FROM task_comments"))).toHaveLength(
          1,
        );
      } finally {
        query.mockRestore();
        raw.exec("ROLLBACK");
      }
    });
  });

  test("freshTaskIds не загружает тела остальных объявленных журналов", async () => {
    await withCommandDatabase(async (db, _peer, raw) => {
      const fresh = record("FRESH-BODY", "task", { title: "Свежий", comments: [] });
      const journalOnly = record("JOURNAL-ONLY", "task", {
        comments: [],
        acceptanceCriteria: [
          {
            id: "criterion",
            title: "Критерий",
            summary: "",
            description: "",
            completed: false,
            completedAt: null,
            completedBy: null,
          },
        ],
      });
      db.insert(fresh);
      db.insert(journalOnly);
      db.appendTaskComment(journalOnly.id, comment("narrow-journal"));
      // Повреждённая часть чужой карточки выявит ненужную полную гидратацию вместо journal-only чтения.
      raw
        .query(
          "UPDATE entity_components SET value=json_set(value,'$.title',123) WHERE owner_id=? AND kind='task-criterion'",
        )
        .run(journalOnly.id);

      const facts = raw
        .transaction(() => readCommandFacts(raw, [fresh.id, journalOnly.id], [fresh.id]))
        .deferred();

      expect([...facts.taskRecords.keys()]).toEqual([fresh.id]);
      expect(facts.comments.get(fresh.id)).toEqual([]);
      expect(facts.comments.get(journalOnly.id)).toEqual([comment("narrow-journal")]);
    });
  });

  test("field-set выбирает один полный набор по буквальному полю независимо от числа значений", async () => {
    await withCommandDatabase(async (db, _peer, raw) => {
      const field = 'owner.id"[]';
      const first = record("FIELD-A", "document", { [field]: "one", body: "Первый" });
      const second = record("FIELD-B", "document", { [field]: "two", body: "Второй" });
      const numericText = record("FIELD-C", "document", { [field]: "5" });
      for (const entry of [
        first,
        second,
        numericText,
        record("FIELD-NUMBER", "document", { [field]: 5 }),
        record("FIELD-PATH", "document", { owner: { id: "one" } }),
        record("FIELD-KIND", "task", { [field]: "one" }),
      ]) {
        db.insert(entry);
      }
      const selector: CommandSelector = {
        kind: "field-set",
        entityKind: "document",
        field,
        values: ["two", "one", "one", "5", "absent"],
      };
      raw.exec("BEGIN DEFERRED");
      const query = spyOn(raw, "query");
      try {
        const selected = loadCommandSelection(raw, selector);

        expect(selected.observation).toMatchObject({
          kind: "records",
          records: [first, second, numericText],
        });
        expect(query.mock.calls.length).toBeLessThanOrEqual(5);
        query.mockClear();
        expect(readCommandGuard(raw, selector).fingerprint).toBe(selected.guard.fingerprint);
        expect(query.mock.calls.length).toBeLessThanOrEqual(3);
        query.mockClear();
        expect(loadCommandSelection(raw, { ...selector, values: [] }).observation).toEqual({
          kind: "records",
          records: [],
          versions: {},
        });
        expect(query.mock.calls).toHaveLength(0);
      } finally {
        query.mockRestore();
        raw.exec("ROLLBACK");
      }
    });
  });
});
