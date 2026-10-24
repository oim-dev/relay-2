import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ReplicationChangeset } from "@relay/contracts";
import { ProjectDatabase } from "@relay/storage";
import { BatchService } from "../../src/batch/batch";
import { TasksService } from "../../src/tasks/tasks";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { ReplicationService } from "../../src/replication/replication";
import { decodeReplicationSnapshot } from "../../src/replication/replication-format";
import { versionComponent } from "../../src/replication/component-merge";
import { withReplicationFixture } from "./helpers/replication-fixture";
import { createLegacyReplicationProject } from "./helpers/replication-legacy-project-fixture";
import {
  redigestSource,
  unverifiedSourcePublication,
} from "./helpers/replication-publication-fixture";

const disguises = [
  {
    name: "только command=storage.atomic",
    disguise: "name",
    path: "source.technical-initialization",
  },
  {
    name: "technical без targets/timestamp/reads/dependencies",
    disguise: "stripped",
    path: "source.technical-initialization",
  },
  {
    name: "technical mutation даже с правильными parents",
    disguise: "valid-parents",
    path: "source.technical-initialization",
  },
  {
    name: "baseline вместо ordinary mutation",
    disguise: "baseline",
    path: "source.technical-initialization",
  },
  {
    name: "удалённая modelVersion при оставшейся model2 tape",
    disguise: "legacy",
    path: "source.legacy.fields",
  },
  { name: "model2 baseline без проверяемой tape", disguise: "no-tape", path: null },
] as const;

/**
 * Подменяет именованную мутацию технической формой, сохраняя корректные hashes и обе копии effects.
 * Stripped-вариант убирает также named metadata и causal queue hints, но не действительные before.
 */
function disguisedMutation(source: ReplicationChangeset, disguise: string): ReplicationChangeset {
  const part = source.components?.find((entry) => entry.after.kind === "task-criterion");
  if (part?.before == null || source.transitions?.length !== 1) {
    throw new Error("Нет исходного изменения критерия");
  }
  const damaged =
    disguise === "valid-parents" ? part : { ...part, after: versionComponent(part.after, []) };
  const changed = {
    ...source,
    components: (source.components ?? []).map((entry) =>
      entry.key === part.key ? damaged : entry,
    ),
    transitions: source.transitions.map((step) => ({
      ...step,
      command: "storage.atomic",
      components: step.components.map((entry) => (entry.key === part.key ? damaged : entry)),
    })),
  };
  if (disguise === "name") {
    return redigestSource(changed);
  }
  if (disguise === "legacy") {
    const { modelVersion: _modelVersion, ...legacy } = changed;
    return redigestSource(legacy);
  }
  if (disguise === "no-tape") {
    const { transitions: _transitions, ...net } = changed;
    return redigestSource({ ...net, mode: "baseline" });
  }
  return redigestSource({
    ...changed,
    mode: disguise === "baseline" ? "baseline" : "mutation",
    replicaId: "untrusted-technical",
    id: "untrusted-technical:1",
    sequence: 1,
    dependencies: [],
    readContext: [],
    transitions: changed.transitions.map((step) => {
      const { targets: _targets, timestamp: _timestamp, ...effects } = step;
      return {
        ...effects,
        command: disguise === "baseline" ? "baseline" : "storage.atomic",
        readContext: [],
        predicates: [],
      };
    }),
  });
}

describe("Закрытый контракт технического source", () => {
  test.each(disguises)(
    "$name не авторизует изменение существующего компонента",
    async ({ disguise, path }) => {
      await withReplicationFixture(
        async (db) => {
          await new TasksService(db).create(
            { title: "Владелец", acceptanceCriteria: [{ title: "До" }] },
            "seed",
          );
        },
        async ({ first, second, remote }) => {
          const task = new TasksService(first).get("PRODUCT-1");
          const criterion = task.data.acceptanceCriteria[0];
          if (criterion === undefined) {
            throw new Error("Нет критерия");
          }
          await new BatchService(first).execute(
            {
              version: 1,
              operations: [
                {
                  op: "task.criterion.update",
                  ref: task.id,
                  ifRevision: task.revision,
                  input: { id: criterion.id, title: "После" },
                },
              ],
            },
            { actor: "author", operationKey: "technical-disguise" },
          );
          const source = first.getReplicationOutbox()[0];
          if (source === undefined) {
            throw new Error("Нет исходного changeset");
          }
          const incoming = unverifiedSourcePublication(remote, disguisedMutation(source, disguise));
          await new KnowledgeService(second).create(
            "feature",
            { name: "Локальная очередь" },
            "local",
          );
          const sync = new ReplicationService(second);
          const before = sync.capture();
          const state = second.getReplicationState();
          const guard = second.getReplicationGuard();
          const pending = second.getReplicationOutbox();
          const failure =
            path === null
              ? { code: "REPLICATION_TRANSITION_REQUIRED" }
              : { code: "REPLICATION_FORMAT", details: { path } };

          expect(() => sync.accept(incoming)).toThrow(expect.objectContaining(failure));

          expect(sync.capture()).toEqual(before);
          expect(second.getReplicationState()).toEqual(state);
          expect(second.getReplicationGuard()).toEqual(guard);
          expect(second.getReplicationOutbox()).toEqual(pending);
          expect(second.getBatchReceipt("technical-disguise")).toBeUndefined();
          expect(new TasksService(second).get(task.id).data.acceptanceCriteria[0]?.title).toBe(
            "До",
          );
          expect(first.getReplicationOutbox()).toEqual([source]);
        },
      );
    },
  );

  test("полный genesis source не применяется повторно поверх непустого canonical parent", async () => {
    await withReplicationFixture(
      () => {},
      async ({ first, second, remote }) => {
        const genesis = remote.publication?.changes[0]?.source;
        if (genesis === undefined) {
          throw new Error("Нет genesis source");
        }
        const repeated = redigestSource({
          ...genesis,
          replicaId: "another-genesis",
          id: "another-genesis:1",
        });
        const incoming = unverifiedSourcePublication(remote, repeated);
        await new KnowledgeService(second).create("feature", { name: "Неподтверждённая" }, "local");
        const sync = new ReplicationService(second);
        const before = sync.capture();
        const state = second.getReplicationState();
        const guard = second.getReplicationGuard();
        const pending = second.getReplicationOutbox();
        expect(() => decodeReplicationSnapshot(incoming)).not.toThrow();

        expect(() => sync.accept(incoming)).toThrow(
          expect.objectContaining({
            code: "REPLICATION_FORMAT",
            details: { path: "source.technical-parent" },
          }),
        );

        expect(sync.capture()).toEqual(before);
        expect(second.getReplicationState()).toEqual(state);
        expect(second.getReplicationGuard()).toEqual(guard);
        expect(second.getReplicationOutbox()).toEqual(pending);
        expect(first.getReplicationOutbox()).toEqual([]);
      },
    );
  });

  test("технический collapsed multi-step без ленты отклоняется, не выдавая последнего parent за прямой before", async () => {
    await withReplicationFixture(
      async (db) => {
        await new BatchService(db).execute(
          {
            version: 1,
            operations: [
              {
                op: "task.create",
                input: { title: "Владелец", acceptanceCriteria: [{ title: "До" }] },
              },
            ],
          },
          { actor: "seed", operationKey: "seed-technical-material" },
        );
      },
      async ({ first, second, remote }) => {
        const task = new TasksService(first).get("PRODUCT-1");
        const material = first.getBatchReceipt("seed-technical-material");
        if (material === undefined) {
          throw new Error("Нет исходной квитанции fixture");
        }
        const receipt = {
          ...material,
          operationKey: "technical-net",
          resultJson: JSON.stringify({
            ...new BatchService(first).getResult("seed-technical-material"),
            operationKey: "technical-net",
            replayed: false,
          }),
        };
        first.transaction(() => {
          const intermediate = {
            ...task,
            revision: task.revision + 1,
            data: {
              ...task.data,
              acceptanceCriteria: task.data.acceptanceCriteria.map((part) => ({
                ...part,
                title: "Шаг 1",
              })),
            },
          };
          first.update(intermediate, task.revision);
          first.update(
            {
              ...intermediate,
              revision: intermediate.revision + 1,
              data: {
                ...intermediate.data,
                acceptanceCriteria: intermediate.data.acceptanceCriteria.map((part) => ({
                  ...part,
                  title: "Шаг 2",
                })),
              },
            },
            intermediate.revision,
          );
          first.insertBatchReceipt(receipt);
        });
        const source = first.getReplicationOutbox()[0];
        const part = source?.components?.find((entry) => entry.after.kind === "task-criterion");
        if (source === undefined || part?.before == null) {
          throw new Error("Нет технического net effect");
        }
        expect(source.transitions).toHaveLength(1);
        expect(source.transitions?.[0]?.command).toBe("storage.atomic");
        expect(part.after.parents).not.toContain(part.before.version);
        const incoming = unverifiedSourcePublication(remote, source);
        await new KnowledgeService(second).create(
          "feature",
          { name: "Локальная очередь" },
          "local",
        );
        const sync = new ReplicationService(second);
        const before = sync.capture();
        const state = second.getReplicationState();
        const pending = second.getReplicationOutbox();

        expect(() => sync.accept(incoming)).toThrow(
          expect.objectContaining({
            code: "REPLICATION_FORMAT",
            details: { path: "source.technical-initialization" },
          }),
        );

        expect(sync.capture()).toEqual(before);
        expect(second.getReplicationState()).toEqual(state);
        expect(second.getReplicationOutbox()).toEqual(pending);
        expect(second.getBatchReceipt("technical-net")).toBeUndefined();
        expect(new TasksService(second).get(task.id).data.acceptanceCriteria[0]?.title).toBe("До");
        expect(first.getReplicationOutbox()).toEqual([source]);
      },
    );
  });

  test("genesis проверяет пустые parents и сохраняет настоящую инициализацию при bootstrap", async () => {
    await withReplicationFixture(
      () => {},
      ({ first, remote, directory }) => {
        const source = remote.publication?.changes[0]?.source;
        const part = source?.components?.[0];
        if (source === undefined || part === undefined || source.transitions === undefined) {
          throw new Error("Нет технического genesis");
        }
        const invalidPart = { ...part, after: versionComponent(part.after, ["f".repeat(64)]) };
        const corrupted = redigestSource({
          ...source,
          components: (source.components ?? []).map((entry) =>
            entry.key === part.key ? invalidPart : entry,
          ),
          transitions: source.transitions.map((step) => ({
            ...step,
            components: step.components.map((entry) =>
              entry.key === part.key ? invalidPart : entry,
            ),
          })),
        });
        const empty = {
          ...remote,
          entities: [],
          components: [],
          addresses: [],
          comments: [],
          receipts: [],
          confirmations: [],
          publication: null,
        };
        const incoming = unverifiedSourcePublication(empty, corrupted);
        const restored = ProjectDatabase.createReplica(
          join(directory, "technical-genesis.sqlite"),
          first.projectId,
        );
        try {
          const restore = new ReplicationService(restored);
          const before = restore.capture();
          const guard = restored.getReplicationGuard();

          expect(() => restore.bootstrap(incoming)).toThrow(
            expect.objectContaining({
              code: "REPLICATION_FORMAT",
              details: { path: "source.component.parents" },
            }),
          );

          expect(restore.capture()).toEqual(before);
          expect(restored.getReplicationGuard()).toEqual(guard);
          expect(restored.getReplicationOutbox()).toEqual([]);
          restore.bootstrap(remote);
          expect(restore.capture().entities).toEqual(remote.entities);
          expect(restore.capture().components).toEqual(remote.components ?? []);
          expect(restore.prepare(remote).snapshot).toEqual(remote);
          expect(restore.status().pending).toBe(0);
        } finally {
          restored.close();
        }
      },
    );
  });

  test("реальная v2 миграция публикует initial baseline с прежними ID, содержанием и receipt", async () => {
    await withReplicationFixture(
      async (db) => {
        await new BatchService(db).execute(
          {
            version: 1,
            operations: [
              {
                op: "task.create",
                input: { title: "Историческая", acceptanceCriteria: [{ title: "Критерий" }] },
              },
              { op: "document.create", input: { name: "Исторический", body: "Точный Markdown" } },
            ],
          },
          { actor: "seed", operationKey: "historical" },
        );
      },
      ({ first, remote, directory }) => {
        const path = join(directory, "real-v2.sqlite");
        createLegacyReplicationProject(path, first.projectId, first.list(), remote.receipts);
        const migrated = ProjectDatabase.open(path);
        let restored: ProjectDatabase | undefined;
        try {
          restored = ProjectDatabase.createReplica(
            join(directory, "migrated-peer.sqlite"),
            first.projectId,
          );
          const source = migrated.getReplicationOutbox()[0];
          expect(source).toMatchObject({ modelVersion: 2, mode: "baseline", sequence: 1 });
          expect(source?.transitions?.[0]?.command).toBe("baseline");
          const before = migrated.getReplicationOutbox();
          const sync = new ReplicationService(migrated);

          const prepared = sync.prepare(null);

          expect(prepared.conflicts).toEqual([]);
          new ReplicationService(restored).bootstrap(prepared.snapshot);
          expect(
            restored
              .list()
              .map((entry) => entry.id)
              .sort(),
          ).toEqual(
            first
              .list()
              .map((entry) => entry.id)
              .sort(),
          );
          expect(new TasksService(restored).get("PRODUCT-1").data.acceptanceCriteria).toEqual(
            new TasksService(first).get("PRODUCT-1").data.acceptanceCriteria,
          );
          expect(restored.get("DOC-1")?.data.body).toBe("Точный Markdown");
          expect(restored.getBatchReceipt("historical")).toEqual(
            first.getBatchReceipt("historical"),
          );
          expect(migrated.getReplicationOutbox()).toEqual(before);
          sync.accept(prepared.snapshot);
          expect(sync.status().pending).toBe(0);
          expect(new ReplicationService(restored).prepare(prepared.snapshot).snapshot).toEqual(
            prepared.snapshot,
          );
        } finally {
          restored?.close();
          migrated.close();
        }
      },
    );
  });
});
