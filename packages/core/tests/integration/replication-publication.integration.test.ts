import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { ProjectDatabase, replicationFingerprint, portableEntity } from "@relay/storage";
import { BatchService } from "../../src/batch/batch";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { PlanningService } from "../../src/planning/planning";
import { TasksService } from "../../src/tasks/tasks";
import { ReplicationService } from "../../src/replication/replication";
import { withReplicationFixture } from "./helpers/replication-fixture";
import { unverifiedPublication } from "./helpers/replication-publication-fixture";
import { validateSnapshot } from "../../src/replication/snapshot-validation";
import { publishChanges } from "../../src/replication/publication";
import { confirmChangeset } from "../../src/replication/confirmations";
import { decodeReplicationSnapshot } from "../../src/replication/replication-format";

describe("Проверяемые ordered публикации", () => {
  test("draft-v3 pending payload публикуется через явную адаптацию без переписи source digest/IDs", async () => {
    await withReplicationFixture(
      async (db) => {
        await new KnowledgeService(db).create("document", { name: "Legacy", body: "До" }, "seed");
      },
      async ({ first, second, remote }) => {
        const knowledge = new KnowledgeService(first);
        const before = knowledge.get("document", "DOC-1");
        const after = await knowledge.update(
          "document",
          before.id,
          { body: "После\ud800" },
          { actor: "legacy-writer", ifRevision: before.revision },
        );
        const current = first.getReplicationOutbox()[0];
        if (current === undefined) {
          throw new Error("Нет исходной мутации");
        }
        const base = portableEntity(before);
        const result = portableEntity(after, [base.version]);
        // Здесь моделируется только прежний immutable payload. Реальный v3→v4 file upgrade проверяет Storage.
        const payload = {
          formatVersion: 1 as const,
          projectId: first.projectId,
          mode: "mutation" as const,
          id: current.id,
          replicaId: current.replicaId,
          sequence: current.sequence,
          createdAt: current.createdAt,
          dependencies: current.dependencies,
          readContext: current.readContext.map(({ logicalDigest: _logicalDigest, ...entry }) =>
            entry.id === before.id ? { ...entry, version: base.version } : entry,
          ),
          entities: [
            {
              id: before.id,
              before: { ...base, record: { ...base.record, revision: before.revision } },
              after: { ...result, record: { ...result.record, revision: after.revision } },
            },
          ],
          addresses: current.addresses,
          comments: [],
          receipts: [],
        };
        const legacy = { ...payload, digest: replicationFingerprint(payload) };
        const bytes = JSON.stringify(legacy, null, 2);
        const raw = new Database(first.path, { strict: true });
        try {
          raw.exec("BEGIN IMMEDIATE");
          raw.query("DELETE FROM replication_outbox WHERE id=?").run(legacy.id);
          raw
            .query("INSERT INTO replication_outbox VALUES(?,?,?)")
            .run(legacy.id, legacy.sequence, bytes);
          raw.exec("COMMIT");
          const sync = new ReplicationService(first);

          const prepared = sync.prepare(remote);

          expect(prepared.conflicts).toEqual([]);
          expect(prepared.included).toEqual([legacy.id]);
          expect(
            raw
              .query<{ json: string }, [string]>("SELECT json FROM replication_outbox WHERE id=?")
              .get(legacy.id)?.json,
          ).toBe(bytes);
          expect(prepared.snapshot.publication?.changes[0]?.source).toEqual(legacy);
          expect(
            prepared.snapshot.entities.every((entry) => !Object.hasOwn(entry.record, "revision")),
          ).toBe(true);
          sync.accept(prepared.snapshot);
          new ReplicationService(second).accept(prepared.snapshot);
          expect(first.get(before.id)?.data.body).toBe("После\ud800");
          expect(second.get(before.id)?.data.body).toBe("После\ud800");
          expect(second.get(before.id)?.updatedBy).toBe("legacy-writer");
          expect(sync.capture().entities).toEqual(
            new ReplicationService(second).capture().entities,
          );
          expect(sync.prepare(prepared.snapshot).snapshot).toEqual(prepared.snapshot);
          expect(sync.status().pending).toBe(0);
        } finally {
          if (raw.inTransaction) {
            raw.exec("ROLLBACK");
          }
          raw.close();
        }
      },
    );
  });

  test("receipt-only product.create не обходит filled canonical before при effects=[]", async () => {
    await withReplicationFixture(
      async (db) => {
        await new KnowledgeService(db).create("product", { name: "Заполненный паспорт" }, "seed");
      },
      async ({ first, second, remote }) => {
        const product = new KnowledgeService(first).get("product", "PRODUCT");
        await new BatchService(first).execute(
          {
            version: 1,
            operations: [
              {
                op: "product.update",
                ifRevision: product.revision,
                input: { name: product.data.name },
              },
            ],
          },
          { actor: "writer", operationKey: "passport-noop" },
        );
        const source = first.getReplicationOutbox()[0];
        const honest = new ReplicationService(first).prepare(remote).snapshot;
        const change = honest.publication?.changes[0];
        if (source === undefined || change === undefined) {
          throw new Error("Нет receipt-only fixture");
        }
        expect(source.entities).toEqual([]);
        // Недоверенный producer подменил смысл no-op, сохранив корректные DTO/digests и прежнее состояние.
        const { digest: _digest, ...original } = source;
        const payload = {
          ...original,
          transitions:
            source.transitions?.map((step) => ({ ...step, command: "product.create" })) ?? [],
        };
        const forgedSource = { ...payload, digest: replicationFingerprint(payload) };
        const forged = publishChanges(
          remote,
          {
            ...honest,
            confirmations: confirmChangeset(
              remote.confirmations,
              source.replicaId,
              source.sequence,
              forgedSource.digest,
            ),
          },
          [
            {
              source: forgedSource,
              resolution: null,
              transitions: change.transitions.map((step, index) =>
                index === 0 ? { ...step, command: "product.create" } : step,
              ),
            },
          ],
        );
        const reader = new ReplicationService(second);
        const before = reader.capture();
        expect(() => decodeReplicationSnapshot(forged)).not.toThrow();

        expect(() => reader.accept(forged)).toThrow(
          expect.objectContaining({ code: "ALREADY_EXISTS", exitCode: 4 }),
        );

        expect(reader.capture()).toEqual(before);
        expect(second.getBatchReceipt("passport-noop")).toBeUndefined();
        expect(second.getReplicationState().base).toEqual(remote);
      },
    );
  });

  test("lone-surrogate comment title/body проходят реальный import и restore без потери code units", async () => {
    await withReplicationFixture(
      async (db) => {
        await new TasksService(db).create({ title: "Журнал" }, "seed");
      },
      async ({ first, second, remote, directory }) => {
        const tasks = new TasksService(first);
        const task = tasks.get("PRODUCT-1");
        const title = "Заголовок\ud800";
        const body = "Строка\udc00\nещё\ud800";
        const appended = await tasks.comment(task.id, body, "author", title);
        expect(appended.data.comments[0]).toMatchObject({ title, body });
        const writer = new ReplicationService(first);
        const published = writer.prepare(remote).snapshot;
        expect(published.comments[0]?.comment).toMatchObject({ title, body });

        writer.accept(published);
        new ReplicationService(second).accept(published);

        expect(new TasksService(second).comments(task.id)[0]).toMatchObject({ title, body });
        expect(new ReplicationService(second).capture().comments).toEqual(published.comments);
        const restored = ProjectDatabase.createReplica(
          join(directory, "comment-lossless.sqlite"),
          first.projectId,
        );
        try {
          const restore = new ReplicationService(restored);
          restore.bootstrap(published, { chain: [remote] });
          expect(new TasksService(restored).comments(task.id)[0]).toEqual(
            published.comments[0]?.comment,
          );
          expect(restore.prepare(published).snapshot).toEqual(published);
          expect(restore.status().pending).toBe(0);
        } finally {
          restored.close();
        }
      },
    );
  });

  test("правильные hashes и готовый final snapshot не разрешают cancelled→released без replanning", async () => {
    await withReplicationFixture(
      async (db) => {
        const tasks = new TasksService(db);
        const task = await tasks.create({ title: "Выполнена" }, "seed");
        await tasks.move(task.id, { column: "done" }, { actor: "seed", ifRevision: task.revision });
        const plans = new PlanningService(db);
        const plan = await plans.create("work-plan", { title: "План", goal: "Цель" }, "seed");
        const staged = await plans.stage(
          plan.id,
          "create",
          { title: "Этап" },
          { actor: "seed", ifRevision: plan.revision },
        );
        const stage = staged.data.stages[0];
        if (stage === undefined) {
          throw new Error("Нет этапа");
        }
        const included = await plans.stageTask(plan.id, stage.id, task.id, false, {
          actor: "seed",
          ifRevision: staged.revision,
        });
        await plans.transition(
          "work-plan",
          plan.id,
          "complete",
          { result: "Готово" },
          { actor: "seed", ifRevision: included.revision },
        );
        const release = await plans.create(
          "release",
          { title: "Релиз", version: "1.0", planIds: [plan.id] },
          "seed",
        );
        await plans.transition(
          "release",
          release.id,
          "cancel",
          {},
          { actor: "seed", ifRevision: release.revision },
        );
      },
      ({ first, remote }) => {
        const before = remote.entities.find((entry) => entry.record.kind === "release");
        if (before === undefined) {
          throw new Error("Нет релиза");
        }
        const timestamp = "2026-10-24T00:00:00.000Z";
        const after = portableEntity(
          {
            ...before.record,
            updatedAt: timestamp,
            updatedBy: "publisher",
            data: {
              ...before.record.data,
              status: "released",
              releasedAt: timestamp,
              releasedBy: "publisher",
            },
          },
          [before.version],
        );
        const forged = unverifiedPublication(remote, before, after, "release.publish");
        const sync = new ReplicationService(first);
        const state = first.getReplicationState();
        const stored = sync.capture();
        expect(() => validateSnapshot(forged)).not.toThrow();

        expect(() => sync.accept(forged)).toThrow(
          expect.objectContaining({ code: "INVALID_TRANSITION" }),
        );

        expect(sync.capture()).toEqual(stored);
        expect(first.getReplicationState()).toEqual(state);
        expect(first.get(before.record.id)?.data.status).toBe("cancelled");
      },
    );
  });

  test("JSON name/body с непарными surrogate сохраняются точно после публикации и bootstrap", async () => {
    const name = "Имя \ud800";
    const body = "До\udc00\nпосле\ud800";
    await withReplicationFixture(
      async (db) => {
        await new KnowledgeService(db).create("document", { name, body }, "author");
      },
      ({ first, second, remote }) => {
        expect(first.get("DOC-1")?.data).toMatchObject({ name, body });
        expect(second.get("DOC-1")?.data).toMatchObject({ name, body });
        expect(
          remote.entities.find((entry) => entry.record.key === "DOC-1")?.record.data,
        ).toMatchObject({ name, body });
        expect(new ReplicationService(second).prepare(remote).snapshot).toEqual(remote);
      },
    );
  });

  test.each(["id", "createdBy"] as const)(
    "не-wellformed UTF-16 %s отвергается до ack и записи пустой восстановляемой БД",
    async (field) => {
      await withReplicationFixture(
        () => {},
        async ({ first, remote, directory }) => {
          const document = await new KnowledgeService(first).create(
            "document",
            { name: "Имя", body: "Содержание" },
            "author",
          );
          const sync = new ReplicationService(first);
          const published = sync.prepare(remote).snapshot;
          const incoming = {
            ...published,
            entities: published.entities.map((entry) =>
              entry.record.id === document.id
                ? portableEntity({ ...entry.record, [field]: "bad\ud800" }, entry.parents)
                : entry,
            ),
          };
          const pending = first.getReplicationOutbox();
          const before = sync.capture();

          expect(() => sync.accept(incoming)).toThrow(
            expect.objectContaining({
              code: "REPLICATION_FORMAT",
              details: { path: `record.${field}` },
            }),
          );
          expect(first.getReplicationOutbox()).toEqual(pending);
          expect(sync.capture()).toEqual(before);
          const restored = ProjectDatabase.createReplica(
            join(directory, `malformed-${field}.sqlite`),
            first.projectId,
          );
          try {
            const restore = new ReplicationService(restored);
            const empty = restore.capture();
            expect(() => restore.bootstrap(incoming, { trustedCheckpoint: true })).toThrow(
              expect.objectContaining({ code: "REPLICATION_FORMAT" }),
            );
            expect(restore.capture()).toEqual(empty);
            expect(restore.status().pending).toBe(0);
          } finally {
            restored.close();
          }
        },
      );
    },
  );

  test("ordinary accept пишет только затронутого owner, не переписывая все первичные части проекта", async () => {
    await withReplicationFixture(
      async (db) => {
        const knowledge = new KnowledgeService(db);
        await knowledge.create("document", { name: "Изменяемый", body: "До" }, "seed");
        await knowledge.create("document", { name: "Незатронутый", body: "Сохранить" }, "seed");
      },
      async ({ first, second, remote }) => {
        const changed = new KnowledgeService(first).get("document", "DOC-1");
        const untouched = second.get("DOC-2");
        await new KnowledgeService(first).update(
          "document",
          changed.id,
          { body: "После" },
          { actor: "author", ifRevision: changed.revision },
        );
        const published = new ReplicationService(first).prepare(remote).snapshot;
        const audit = new Database(second.path, { strict: true });
        try {
          audit.exec(
            "CREATE TABLE import_audit(kind TEXT,id TEXT); CREATE TRIGGER audit_entity AFTER UPDATE ON entities BEGIN INSERT INTO import_audit VALUES('entity',NEW.id); END; CREATE TRIGGER audit_component AFTER UPDATE ON entity_components BEGIN INSERT INTO import_audit VALUES('component',NEW.id); END;",
          );

          new ReplicationService(second).accept(published);

          expect(audit.query("SELECT * FROM import_audit").all()).toEqual([
            { kind: "entity", id: changed.id },
          ]);
          expect(second.get("DOC-2")).toEqual(untouched);
          expect(second.get(changed.id)?.data.body).toBe("После");
          expect(second.getReplicationOutbox()).toEqual([]);
        } finally {
          audit.close();
        }
      },
    );
  });

  test("pruned proof не подтверждает очередь даже при сохранённом максимальном sequence", async () => {
    await withReplicationFixture(
      () => {},
      async ({ first, remote }) => {
        await new KnowledgeService(first).create(
          "document",
          { name: "Ожидающий", body: "Payload" },
          "author",
        );
        const sync = new ReplicationService(first);
        const prepared = sync.prepare(remote);
        const before = first.getReplicationOutbox();
        const damaged = {
          ...prepared.snapshot,
          confirmations: prepared.snapshot.confirmations.map((entry, index) =>
            index === 0 ? { ...entry, proofs: (entry.proofs ?? []).slice(1) } : entry,
          ),
        };

        expect(() => sync.accept(damaged)).toThrow(
          expect.objectContaining({ code: "REPLICATION_FORMAT" }),
        );

        expect(first.getReplicationOutbox()).toEqual(before);
        expect(sync.status().pending).toBe(1);
        expect(first.get("DOC-1")?.data.body).toBe("Payload");
      },
    );
  });

  test("переносимое remote-решение не разрешает зависимый пакет с отвергнутой новой целью", async () => {
    await withReplicationFixture(
      async (db) => {
        await new KnowledgeService(db).create("feature", { name: "Общая" }, "seed");
      },
      async ({ first, second, remote }) => {
        const batch = await new BatchService(first).execute(
          {
            version: 1,
            operations: [
              {
                op: "feature.update",
                ref: "FEATURE-1",
                ifRevision: 1,
                input: { name: "Локальная" },
              },
              { op: "task.create", input: { title: "Новая цель" } },
            ],
          },
          { actor: "author", operationKey: "rejected-parent" },
        );
        const target = new TasksService(first).get("PRODUCT-1");
        const dependent = await new KnowledgeService(first).create(
          "document",
          { name: "Зависимый", body: "Ссылка", targets: [target.id] },
          "author",
        );
        await new KnowledgeService(second).update(
          "feature",
          "FEATURE-1",
          { name: "Принятая" },
          { actor: "other", ifRevision: 1 },
        );
        const published = new ReplicationService(second).prepare(remote).snapshot;
        const sync = new ReplicationService(first);
        const conflict = sync
          .prepare(published)
          .conflicts.find((entry) => entry.code === "REPLICATION_CONFLICT");
        if (conflict === undefined) {
          throw new Error("Нет конфликта");
        }
        const original = first.getReplicationOutbox()[0];

        const resolved = sync.resolve(
          conflict.id,
          { fingerprint: conflict.fingerprint, choice: "remote" },
          "resolver",
        );

        expect(resolved.included).toEqual([conflict.id]);
        expect(resolved.conflicts.map((entry) => entry.code)).toEqual(["REPLICATION_DEPENDENCY"]);
        expect(
          resolved.snapshot.entities.some(
            (entry) => entry.record.id === target.id || entry.record.id === dependent.id,
          ),
        ).toBe(false);
        const resolution = resolved.snapshot.publication?.changes[0]?.resolution;
        expect(resolution).toMatchObject({
          changesetId: conflict.id,
          sourceDigest: original?.digest,
          actor: "resolver",
          choice: "remote",
        });
        expect(resolved.snapshot.publication?.accepted[0]?.resolutionId).toBe(
          resolution?.resolutionId,
        );
        new ReplicationService(second).accept(resolved.snapshot, { chain: [published] });
        expect(new BatchService(second).getResult("rejected-parent")).toEqual({
          ...batch,
          replayed: true,
        });
        expect(first.getReplicationOutbox()[0]).toEqual(original);
        const dependentConflict = resolved.conflicts[0];
        if (dependentConflict === undefined) {
          throw new Error("Нет зависимого конфликта");
        }
        const discarded = sync.resolve(
          dependentConflict.id,
          { fingerprint: dependentConflict.fingerprint, choice: "remote" },
          "resolver",
        );
        expect(discarded.conflicts).toEqual([]);
        sync.accept(discarded.snapshot);
        expect(sync.status().pending).toBe(0);
        expect(first.get(target.id)).toBeUndefined();
        expect(first.get(dependent.id)).toBeUndefined();
      },
    );
  });

  test("no-op task.move в receipt-only batch повторно проверяет обязательства по явному ownerId", async () => {
    await withReplicationFixture(
      async (db) => {
        const tasks = new TasksService(db);
        const dependency = await tasks.create({ title: "Обязательство" }, "seed");
        await tasks.move(
          dependency.id,
          { column: "done" },
          { actor: "seed", ifRevision: dependency.revision },
        );
        const task = await tasks.create({ title: "Завершённая" }, "seed");
        const linked = await tasks.dependency(task.id, dependency.id, false, {
          actor: "seed",
          ifRevision: task.revision,
        });
        await tasks.move(
          task.id,
          { column: "done" },
          { actor: "seed", ifRevision: linked.revision },
        );
      },
      async ({ first, second, remote }) => {
        const task = new TasksService(first).get("PRODUCT-2");
        const receipt = await new BatchService(first).execute(
          {
            version: 1,
            operations: [
              {
                op: "task.move",
                ref: task.id,
                ifRevision: task.revision,
                input: { column: "done" },
              },
            ],
          },
          { actor: "author", operationKey: "noop-done" },
        );
        const source = first.getReplicationOutbox()[0];
        expect(source?.entities).toEqual([]);
        expect(source?.transitions?.[0]?.targets?.ownerIds).toContain(task.id);
        const dependency = new TasksService(second).get("PRODUCT-1");
        await new TasksService(second).move(
          dependency.id,
          { column: "ready" },
          { actor: "other", ifRevision: dependency.revision },
        );
        const published = new ReplicationService(second).prepare(remote).snapshot;

        const prepared = new ReplicationService(first).prepare(published);

        expect(prepared.included).toEqual([]);
        expect(prepared.conflicts[0]?.code).toBe("TASK_INCOMPLETE");
        expect(new BatchService(first).getResult("noop-done")).toEqual({
          ...receipt,
          replayed: true,
        });
        expect(first.getReplicationOutbox()[0]?.digest).toBe(source?.digest);
      },
    );
  });

  test("local CAS не переносится, import повышает свой guard и обратная доставка не создаёт echo", async () => {
    await withReplicationFixture(
      async (db) => {
        const knowledge = new KnowledgeService(db);
        const created = await knowledge.create(
          "document",
          { name: "Исходный", body: "Точно" },
          "author",
        );
        await knowledge.update(
          "document",
          created.id,
          { name: "До публикации" },
          { actor: "author", ifRevision: created.revision },
        );
      },
      async ({ first, second, remote }) => {
        const a = new ReplicationService(first);
        const b = new ReplicationService(second);
        const original = first.get("DOC-1");
        const replica = second.get("DOC-1");
        expect(original?.revision).toBe(2);
        expect(replica?.revision).toBe(1);
        expect(remote.entities.every((entry) => !Object.hasOwn(entry.record, "revision"))).toBe(
          true,
        );
        if (replica === undefined) {
          throw new Error("Нет документа");
        }
        await new KnowledgeService(second).update(
          "document",
          replica.id,
          { body: "Удалённая версия" },
          { actor: "other", ifRevision: replica.revision },
        );

        const published = b.prepare(remote).snapshot;
        b.accept(published);
        a.accept(published);
        const importedRevision = first.get(replica.id)?.revision;

        expect(importedRevision).toBe(3);
        expect(a.capture().entities).toEqual(b.capture().entities);
        expect(a.prepare(published).snapshot).toEqual(published);
        expect(a.status().pending).toBe(0);
        a.accept(published);
        expect(first.get(replica.id)?.revision).toBe(importedRevision);
        await expect(
          new KnowledgeService(first).update(
            "document",
            replica.id,
            { body: "Устаревший" },
            { actor: "old", ifRevision: 2 },
          ),
        ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
        expect(first.get(replica.id)?.data.body).toBe("Удалённая версия");
      },
    );
  });

  test("complete и publish до reopen dependency проверяются на своих границах внутри одного batch", async () => {
    await withReplicationFixture(
      async (db) => {
        const tasks = new TasksService(db);
        const plans = new PlanningService(db);
        const dependency = await tasks.create({ title: "Зависимость" }, "seed");
        await tasks.move(
          dependency.id,
          { column: "done" },
          { actor: "seed", ifRevision: dependency.revision },
        );
        const task = await tasks.create({ title: "Результат" }, "seed");
        const linked = await tasks.dependency(task.id, dependency.id, false, {
          actor: "seed",
          ifRevision: task.revision,
        });
        await tasks.move(
          task.id,
          { column: "done" },
          { actor: "seed", ifRevision: linked.revision },
        );
        const plan = await plans.create(
          "work-plan",
          { title: "Готовый состав", goal: "Цель" },
          "seed",
        );
        const staged = await plans.stage(
          plan.id,
          "create",
          { title: "Выпуск" },
          { actor: "seed", ifRevision: plan.revision },
        );
        const stage = staged.data.stages[0];
        if (stage === undefined) {
          throw new Error("Нет этапа");
        }
        const included = await plans.stageTask(plan.id, stage.id, task.id, false, {
          actor: "seed",
          ifRevision: staged.revision,
        });
        await plans.transition(
          "work-plan",
          plan.id,
          "start",
          {},
          { actor: "seed", ifRevision: included.revision },
        );
        const release = await plans.create(
          "release",
          { title: "Релиз", version: "1.0", planIds: [plan.id] },
          "seed",
        );
        await plans.transition(
          "release",
          release.id,
          "plan",
          {},
          { actor: "seed", ifRevision: release.revision },
        );
      },
      async ({ first, second, remote }) => {
        const plans = new PlanningService(first);
        const plan = plans.get("work-plan", "PLN-1");
        const release = plans.get("release", "REL-1");
        const dependency = new TasksService(first).get("PRODUCT-1");
        const batch = await new BatchService(first).execute(
          {
            version: 1,
            operations: [
              {
                op: "plan.complete",
                ref: plan.id,
                ifRevision: plan.revision,
                input: { result: "Проверено до reopen" },
              },
              { op: "release.publish", ref: release.id, ifRevision: release.revision, input: {} },
              {
                op: "task.move",
                ref: dependency.id,
                ifRevision: dependency.revision,
                input: { column: "ready" },
              },
            ],
          },
          { actor: "author", operationKey: "publish-and-reopen" },
        );
        const source = first.getReplicationOutbox()[0];
        expect(source?.transitions?.map((step) => step.command)).toEqual([
          "plan.complete",
          "release.publish",
          "task.move",
        ]);
        const sync = new ReplicationService(first);

        const prepared = sync.prepare(remote);

        expect(prepared.conflicts).toEqual([]);
        new ReplicationService(second).accept(prepared.snapshot);
        expect(second.get(dependency.id)?.data.column).toBe("ready");
        expect(second.get(plan.id)?.data.status).toBe("completed");
        expect(second.get(release.id)?.data.status).toBe("released");
        expect(new BatchService(second).getResult("publish-and-reopen")).toEqual({
          ...batch,
          replayed: true,
        });
        const accepted = prepared.snapshot.publication?.accepted[0];
        expect(accepted?.sourceDigest).toBe(source?.digest);
        expect(accepted?.effectDigest).toBe(
          replicationFingerprint(prepared.snapshot.publication?.changes[0]?.transitions),
        );
        expect(
          prepared.snapshot.publication?.changes[0]?.transitions.map((step) => step.command),
        ).toEqual(["plan.complete", "release.publish", "task.move", "receipt"]);
      },
    );
  });

  test("пропущенная публикация требует chain, а изменённая effective лента отклоняется до ack", async () => {
    await withReplicationFixture(
      async (db) => {
        await new KnowledgeService(db).create("document", { name: "Первый", body: "v0" }, "author");
      },
      async ({ first, second, remote, directory }) => {
        const reader = new ReplicationService(second);
        const created = new KnowledgeService(first).get("document", "DOC-1");
        const original = remote.entities.find((entry) => entry.record.id === created.id);
        if (original === undefined) {
          throw new Error("Нет исходной записи");
        }
        // Впервые полученная Git-история: producer не выдавал этому процессу Core proof.
        const firstVersion = portableEntity(
          {
            ...original.record,
            updatedAt: "2026-10-24T00:00:00.000Z",
            data: { ...original.record.data, body: "v1" },
          },
          [original.version],
        );
        const middle = unverifiedPublication(remote, original, firstVersion, "document.update", 1);
        const secondVersion = portableEntity(
          {
            ...firstVersion.record,
            updatedAt: "2026-10-24T00:00:01.000Z",
            data: { ...firstVersion.record.data, body: "v2" },
          },
          [firstVersion.version],
        );
        const final = unverifiedPublication(
          middle,
          firstVersion,
          secondVersion,
          "document.update",
          2,
        );
        const before = reader.capture();

        expect(() => reader.accept(final)).toThrow(
          expect.objectContaining({ code: "REPLICATION_PUBLICATION_REQUIRED" }),
        );
        expect(reader.capture()).toEqual(before);
        const changed = structuredClone(final);
        const publication = changed.publication;
        if (publication === null || publication === undefined) {
          throw new Error("Нет publication");
        }
        const corrupted = {
          ...changed,
          publication: {
            ...publication,
            changes: publication.changes.map((change) => ({ ...change, transitions: [] })),
          },
        };
        expect(() => reader.accept(corrupted, { chain: [middle] })).toThrow(
          expect.objectContaining({ code: "REPLICATION_PUBLICATION" }),
        );
        expect(reader.capture()).toEqual(before);

        const restored = ProjectDatabase.createReplica(
          join(directory, "checkpoint.sqlite"),
          first.projectId,
        );
        try {
          const restore = new ReplicationService(restored);
          expect(() => restore.bootstrap(final)).toThrow(
            expect.objectContaining({ code: "REPLICATION_PUBLICATION_REQUIRED" }),
          );
          reader.accept(final, { chain: [middle] });
          expect(second.get(created.id)?.data.body).toBe("v2");
          restore.bootstrap(final, { trustedCheckpoint: true });
          expect(restored.get(created.id)?.data.body).toBe("v2");
          expect(restore.status().pending).toBe(0);
        } finally {
          restored.close();
        }
      },
    );
  });
});
