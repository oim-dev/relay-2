import { expect, setSystemTime, test } from "bun:test";
import { dirname, join } from "node:path";
import { ProjectDatabase, portableAggregateVersion } from "@relay/storage";
import { CommandExecutor, BatchService } from "../../src/batch/batch";
import { readVersionedEntity } from "../../src/commands/command-versioned-read";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { TasksService } from "../../src/tasks/tasks";
import { ReplicationService } from "../../src/replication/replication";
import { expectAsyncRelayError } from "./helpers/entity-fixture";
import { withCommandExecutorDatabase } from "./helpers/command-executor-fixture";

test("versioned read выдаёт переносимые версии отдельно от raw data и согласованно с сохранёнными частями", async () => {
  await withCommandExecutorDatabase(async (database) => {
    const task = await new TasksService(database).create(
      { title: "Версии содержания", acceptanceCriteria: [{ title: "Первый критерий" }] },
      "автор",
    );

    const observed = await readVersionedEntity(database.commands, task.id, "task");
    const snapshot = new ReplicationService(database).capture();
    const stored = snapshot.entities.find((entity) => entity.record.id === task.id);

    if (stored === undefined || snapshot.components === undefined) {
      throw new Error("Сохранённая задача отсутствует в проверочном snapshot");
    }
    expect(observed.entity).toEqual(task);
    expect(observed.versions.recordVersion).toBe(stored.version);
    expect(observed.versions.aggregateVersion).toBe(
      portableAggregateVersion(stored, snapshot.components),
    );
    expect(Object.hasOwn(observed.entity, "version")).toBe(false);
    expect(Object.hasOwn(observed.entity.data, "aggregateVersion")).toBe(false);
  });
});

test("expectedVersion меняет документ без numeric CAS и отвергает устаревший token до no-op", async () => {
  await withCommandExecutorDatabase(async (database) => {
    const knowledge = new KnowledgeService(database);
    const original = await knowledge.create("document", { name: "Токен", body: "До" }, "автор");
    const executor = new CommandExecutor(database);
    const observed = await executor.readVersioned(original.id);

    const result = await executor.execute(
      {
        op: "document.update",
        ref: original.id,
        expectedVersion: observed.versions.aggregateVersion,
        input: { body: "После" },
      },
      { actor: "редактор" },
    );
    const beforeFailure = database.getGeneration();
    const failure = await expectAsyncRelayError(
      () =>
        executor.execute(
          {
            op: "document.update",
            ref: original.id,
            expectedVersion: observed.versions.aggregateVersion,
            input: { body: "После" },
          },
          { actor: "редактор", operationKey: "stale-version" },
        ),
      "VERSION_CONFLICT",
    );

    expect(result.entities[0]).toMatchObject({
      id: original.id,
      revision: original.revision + 1,
      data: { body: "После" },
    });
    expect(failure.details).toMatchObject({
      path: "operations[0].expectedVersion",
      expectedVersion: observed.versions.aggregateVersion,
    });
    expect(database.getGeneration()).toBe(beforeFailure);
    expect(database.getBatchReceipt("stale-version")).toBeUndefined();
    expect(knowledge.get("document", original.id).data.body).toBe("После");
  });
});

test("при двух переданных условиях expectedVersion не подменяет устаревший ifRevision", async () => {
  await withCommandExecutorDatabase(async (database) => {
    const knowledge = new KnowledgeService(database);
    const original = await knowledge.create("document", { name: "Два guard", body: "До" }, "автор");
    const changed = await knowledge.update(
      "document",
      original.id,
      { body: "Актуальный текст" },
      { actor: "редактор", ifRevision: original.revision },
    );
    const executor = new CommandExecutor(database);
    const current = await executor.readVersioned(changed.id);

    await expectAsyncRelayError(
      () =>
        executor.execute(
          {
            op: "document.update",
            ref: original.id,
            ifRevision: original.revision,
            expectedVersion: current.versions.aggregateVersion,
            input: { body: "Не сохранять" },
          },
          { actor: "редактор" },
        ),
      "REVISION_CONFLICT",
    );

    expect(knowledge.get("document", original.id)).toEqual(changed);
  });
});

test("свежий numeric CAS не обходит stale expectedVersion даже при no-op, оба актуальных условия допустимы", async () => {
  await withCommandExecutorDatabase(async (database) => {
    const knowledge = new KnowledgeService(database);
    const original = await knowledge.create(
      "document",
      { name: "Два независимых условия", body: "До" },
      "автор",
    );
    const executor = new CommandExecutor(database);
    const before = await executor.readVersioned(original.id);
    const changed = await knowledge.update(
      "document",
      original.id,
      { body: "После" },
      { actor: "редактор", ifRevision: original.revision },
    );
    const current = await executor.readVersioned(original.id);
    const generation = database.getGeneration();
    const outbox = database.getReplicationOutbox();

    const failure = await expectAsyncRelayError(
      () =>
        executor.execute(
          {
            op: "document.update",
            ref: original.id,
            ifRevision: changed.revision,
            expectedVersion: before.versions.aggregateVersion,
            input: { body: changed.data.body },
          },
          { actor: "редактор", operationKey: "fresh-number-stale-token" },
        ),
      "VERSION_CONFLICT",
    );

    expect(failure.details).toMatchObject({ path: "operations[0].expectedVersion" });
    expect(knowledge.get("document", original.id)).toEqual(changed);
    expect(database.getGeneration()).toBe(generation);
    expect(database.getReplicationOutbox()).toEqual(outbox);
    expect(database.getBatchReceipt("fresh-number-stale-token")).toBeUndefined();
    const valid = await executor.execute(
      {
        op: "document.update",
        ref: original.id,
        ifRevision: changed.revision,
        expectedVersion: current.versions.aggregateVersion,
        input: { body: changed.data.body },
      },
      { actor: "редактор" },
    );
    expect(valid.entities[0]).toEqual(changed);
    expect(database.getGeneration()).toBe(generation);
    expect(database.getReplicationOutbox()).toEqual(outbox);
  });
});

test("child-only изменение при прежней primary version меняет aggregate token и отклоняет старое условие", async () => {
  await withCommandExecutorDatabase(async (database) => {
    setSystemTime(new Date());
    try {
      const tasks = new TasksService(database);
      const task = await tasks.create(
        { title: "Одинаковые часы и автор", acceptanceCriteria: [{ title: "Первый" }] },
        "автор",
      );
      const executor = new CommandExecutor(database);
      const before = await executor.readVersioned(task.id, "task");

      await tasks.criterion(
        task.id,
        "add",
        { title: "Второй" },
        { actor: "автор", ifRevision: task.revision },
      );
      const after = await executor.readVersioned(task.id, "task");
      await expectAsyncRelayError(
        () =>
          executor.execute(
            {
              op: "task.update",
              ref: task.id,
              expectedVersion: before.versions.aggregateVersion,
              input: { title: "Старое условие" },
            },
            { actor: "автор" },
          ),
        "VERSION_CONFLICT",
      );

      expect(after.versions.recordVersion).toBe(before.versions.recordVersion);
      expect(after.versions.aggregateVersion).not.toBe(before.versions.aggregateVersion);
      expect(tasks.get(task.id).data.acceptanceCriteria.map((entry) => entry.title)).toEqual([
        "Первый",
        "Второй",
      ]);
      expect(tasks.get(task.id).data.title).toBe("Одинаковые часы и автор");
    } finally {
      setSystemTime();
    }
  });
});

test("независимый append сохраняет aggregate token содержания и не исчезает при version-only update", async () => {
  await withCommandExecutorDatabase(async (database) => {
    const tasks = new TasksService(database);
    const task = await tasks.create({ title: "Наблюдение" }, "автор");
    const executor = new CommandExecutor(database);
    const before = await executor.readVersioned(task.id);

    await tasks.comment(task.id, "Между чтением и записью", "другой");
    const appended = await executor.readVersioned(task.id);
    await executor.execute(
      {
        op: "task.update",
        ref: task.id,
        expectedVersion: before.versions.aggregateVersion,
        input: { title: "После наблюдения" },
      },
      { actor: "автор" },
    );

    expect(appended.versions).toEqual(before.versions);
    expect(tasks.get(task.id)).toMatchObject({
      revision: task.revision + 1,
      data: {
        title: "После наблюдения",
        comments: [{ body: "Между чтением и записью", createdBy: "другой" }],
      },
    });
  });
});

test("переносимый token работает после restore с другой локальной revision", async () => {
  await withCommandExecutorDatabase(async (database) => {
    const knowledge = new KnowledgeService(database);
    const document = await knowledge.create(
      "document",
      { name: "Переносимый guard", body: "Первая версия" },
      "автор",
    );
    await knowledge.update(
      "document",
      document.id,
      { body: "Вторая версия" },
      { actor: "редактор", ifRevision: document.revision },
    );
    const sync = new ReplicationService(database);
    const prepared = sync.prepare(null);
    expect(prepared.conflicts).toEqual([]);
    const snapshot = prepared.snapshot;
    sync.accept(snapshot);
    const observed = await new CommandExecutor(database).readVersioned(document.id);
    const restored = ProjectDatabase.createReplica(
      join(dirname(database.path), "restored.sqlite"),
      database.projectId,
    );
    try {
      new ReplicationService(restored).bootstrap(snapshot);
      const executor = new CommandExecutor(restored);
      const local = await executor.readVersioned(document.id);

      const result = await executor.execute(
        {
          op: "document.update",
          ref: document.id,
          expectedVersion: observed.versions.aggregateVersion,
          input: { body: "После восстановления" },
        },
        { actor: "новый редактор" },
      );

      expect(local.entity.revision).not.toBe(observed.entity.revision);
      expect(local.versions).toEqual(observed.versions);
      expect(result.entities[0]).toMatchObject({
        id: document.id,
        revision: local.entity.revision + 1,
        data: { body: "После восстановления" },
      });
    } finally {
      restored.close();
    }
  });
});

test("старый literal token не актуализируется внутри batch, а $revision ссылается на проверенный результат", async () => {
  await withCommandExecutorDatabase(async (database) => {
    const knowledge = new KnowledgeService(database);
    const document = await knowledge.create(
      "document",
      { name: "Промежуточные версии", body: "Исходный" },
      "автор",
    );
    const observed = await new CommandExecutor(database).readVersioned(document.id);
    const first = {
      op: "document.update",
      ref: document.id,
      expectedVersion: observed.versions.aggregateVersion,
      as: "first",
      input: { body: "Промежуточный" },
    };
    const batch = new BatchService(database);

    await expectAsyncRelayError(
      () =>
        batch.execute(
          {
            version: 1,
            operations: [
              first,
              {
                op: "document.update",
                ref: document.id,
                expectedVersion: observed.versions.aggregateVersion,
                input: { body: "Старый token" },
              },
            ],
          },
          { actor: "автор", operationKey: "old-overlay-version" },
        ),
      "VERSION_CONFLICT",
    );
    expect(knowledge.get("document", document.id)).toEqual(document);
    expect(database.getBatchReceipt("old-overlay-version")).toBeUndefined();
    const result = await batch.execute(
      {
        version: 1,
        operations: [
          first,
          {
            op: "document.update",
            ref: document.id,
            ifRevision: { $revision: "first" },
            input: { body: "Итоговый" },
          },
        ],
      },
      { actor: "автор", operationKey: "version-then-local-reference" },
    );

    expect(result.items.map((item) => item.owner.revision)).toEqual([
      document.revision + 1,
      document.revision + 2,
    ]);
    expect(knowledge.get("document", document.id).data.body).toBe("Итоговый");
  });
});

test("versioned read не направляет lone-surrogate адрес на существующий replacement-character ключ", async () => {
  await withCommandExecutorDatabase(async (database) => {
    const knowledge = new KnowledgeService(database);
    const document = await knowledge.create(
      "document",
      { name: "Не та цель", body: "Сохранить" },
      "автор",
    );
    const renamed = await knowledge.rename("document", document.id, "DOC-\ufffd", {
      actor: "автор",
      ifRevision: document.revision,
    });

    await expectAsyncRelayError(
      () => readVersionedEntity(database.commands, "DOC-\ud800"),
      "VALIDATION_ERROR",
    );

    expect(knowledge.get("document", "DOC-\ufffd")).toEqual(renamed);
  });
});
