import { describe, expect, test } from "bun:test";
import {
  componentIdentity,
  type ReplicationChangeset,
  type PortableProjectSnapshot,
} from "@relay/contracts";
import { portableEntity } from "@relay/storage";
import { BatchService } from "../../src/batch/batch";
import { TasksService } from "../../src/tasks/tasks";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { ReplicationService } from "../../src/replication/replication";
import { versionComponent } from "../../src/replication/component-merge";
import { withReplicationFixture } from "./helpers/replication-fixture";
import {
  redigestSource,
  unverifiedSourcePublication,
} from "./helpers/replication-publication-fixture";

const parentCorruptions = [
  { name: "пропущенный parent изменения", damage: "missing" },
  { name: "чужой parent изменения", damage: "foreign" },
  { name: "лишний parent изменения", damage: "extra" },
  { name: "выдуманный parent создания", damage: "genesis" },
  { name: "новая версия неизменённого содержания", damage: "unchanged" },
] as const;
const foreignParent = "f".repeat(64);

/**
 * Задаёт точный повреждённый набор причинных родителей; ожидаемый отказ не вычисляется merge-алгоритмом.
 */
function corruptedParents(damage: string, beforeVersion: string | undefined): readonly string[] {
  if (damage === "missing") {
    return [];
  }
  if (damage === "foreign" || damage === "genesis") {
    return [foreignParent];
  }
  if (beforeVersion === undefined) {
    throw new Error("Нет before для повреждения parents");
  }
  return damage === "extra" ? [beforeVersion, foreignParent].sort() : [beforeVersion];
}

/**
 * Подменяет обе копии исходного entity/component эффекта, сохраняя корректные hashes и coverage tape.
 * У no-op добавляет ложную новую версию существующего неизменённого содержания.
 */
function corruptSourceParents(
  source: ReplicationChangeset,
  remote: PortableProjectSnapshot,
  kind: "entity" | "component",
  damage: string,
): ReplicationChangeset {
  const transitions = source.transitions;
  const first = transitions?.[0];
  if (first === undefined || transitions === undefined) {
    throw new Error("Нет исходной boundary");
  }
  if (kind === "entity") {
    const prior = remote.entities.find((entry) => entry.record.key === "DOC-1");
    const original = first.entities[0];
    const before = damage === "unchanged" ? prior : original?.before;
    const after = damage === "unchanged" ? prior : original?.after;
    if (before === undefined || after == null) {
      throw new Error("Нет версии документа");
    }
    const changed = {
      id: after.record.id,
      before,
      after: portableEntity(after.record, corruptedParents(damage, before?.version)),
    };
    return redigestSource({
      ...source,
      entities: [...source.entities.filter((entry) => entry.id !== changed.id), changed],
      transitions: transitions.map((step, index) =>
        index === 0
          ? {
              ...step,
              // Для no-op сохраняем исходное авторство данных, чтобы отказ проверял именно причинность.
              actor: after.record.updatedBy,
              timestamp: after.record.updatedAt,
              entities: [changed],
            }
          : step,
      ),
    });
  }
  const prior = remote.components?.find((part) => part.kind === "task-criterion");
  const original = first.components.find((part) => part.after.kind === "task-criterion");
  const before = damage === "unchanged" ? prior : original?.before;
  const after = damage === "unchanged" ? prior : original?.after;
  if (before === undefined || after === undefined) {
    throw new Error("Нет версии критерия");
  }
  const changed = {
    key: componentIdentity(after),
    before,
    after: versionComponent(after, corruptedParents(damage, before?.version)),
  };
  return redigestSource({
    ...source,
    components: [
      ...(source.components ?? []).filter((entry) => entry.key !== changed.key),
      changed,
    ],
    transitions: transitions.map((step, index) =>
      index === 0
        ? {
            ...step,
            components: [...step.components.filter((part) => part.key !== changed.key), changed],
          }
        : step,
    ),
  });
}

describe("Точная причинность исходной команды", () => {
  for (const kind of ["entity", "component"] as const) {
    test.each(parentCorruptions)(
      `${kind}: $name отклоняется до импорта, ack и receipt`,
      async ({ damage }) => {
        await withReplicationFixture(
          async (db) => {
            if (kind === "entity") {
              await new KnowledgeService(db).create(
                "document",
                { name: "Основа", body: "До" },
                "seed",
              );
            } else {
              await new TasksService(db).create(
                { title: "Задача", acceptanceCriteria: [{ title: "До" }] },
                "seed",
              );
            }
          },
          async ({ first, second, remote }) => {
            const task =
              kind === "component" ? new TasksService(first).get("PRODUCT-1") : undefined;
            const criterion = task?.data.acceptanceCriteria[0];
            const document = first.get("DOC-1");
            const inputText = damage === "unchanged" ? "До" : "После";
            const batch = new BatchService(first);
            if (kind === "entity") {
              if (document === undefined) {
                throw new Error("Нет документа");
              }
              await batch.execute(
                {
                  version: 1,
                  operations: [
                    damage === "genesis"
                      ? { op: "document.create", input: { name: "Новый", body: inputText } }
                      : {
                          op: "document.update",
                          ref: document.id,
                          ifRevision: document.revision,
                          input: { body: inputText },
                        },
                    { op: "document.create", input: { name: "Спутник", body: "Атомарность" } },
                  ],
                },
                { actor: "author", operationKey: "bad-parents" },
              );
            } else {
              if (task === undefined || criterion === undefined) {
                throw new Error("Нет задачи с критерием");
              }
              await batch.execute(
                {
                  version: 1,
                  operations: [
                    damage === "genesis"
                      ? {
                          op: "task.criterion.add",
                          ref: task.id,
                          ifRevision: task.revision,
                          input: { title: inputText },
                        }
                      : {
                          op: "task.criterion.update",
                          ref: task.id,
                          ifRevision: task.revision,
                          input: { id: criterion.id, title: inputText },
                        },
                    { op: "document.create", input: { name: "Спутник", body: "Атомарность" } },
                  ],
                },
                { actor: "author", operationKey: "bad-parents" },
              );
            }
            const source = first.getReplicationOutbox()[0];
            if (source === undefined) {
              throw new Error("Нет исходного changeset");
            }
            const bad = corruptSourceParents(source, remote, kind, damage);
            const incoming = unverifiedSourcePublication(remote, bad);
            await new KnowledgeService(second).create(
              "feature",
              { name: "Локальное ожидание" },
              "local",
            );
            const peer = new ReplicationService(second);
            const before = peer.capture();
            const state = second.getReplicationState();
            const pending = second.getReplicationOutbox();
            const path =
              kind === "entity" && ["missing", "foreign"].includes(damage)
                ? "effects.entity.parents"
                : `source.${kind}.parents`;

            expect(() => peer.accept(incoming)).toThrow(
              expect.objectContaining({ code: "REPLICATION_FORMAT", details: { path } }),
            );

            expect(peer.capture()).toEqual(before);
            expect(second.getReplicationState()).toEqual(state);
            expect(second.getReplicationOutbox()).toEqual(pending);
            expect(second.getBatchReceipt("bad-parents")).toBeUndefined();
            expect(second.list("document").some((entry) => entry.data.name === "Спутник")).toBe(
              false,
            );
            if (kind === "entity") {
              expect(second.get("DOC-1")?.data.body).toBe("До");
            } else {
              expect(
                new TasksService(second)
                  .get("PRODUCT-1")
                  .data.acceptanceCriteria.map((entry) => entry.title),
              ).toEqual(["До"]);
            }
          },
        );
      },
    );
  }

  test("последовательные source parents не навязывают одного предка net effects и конкурентному merge", async () => {
    await withReplicationFixture(
      async (db) => {
        await new TasksService(db).create(
          { title: "Задача", acceptanceCriteria: [{ title: "До", description: "Основа" }] },
          "seed",
        );
      },
      async ({ first, second, remote }) => {
        const tasks = new TasksService(first);
        const task = tasks.get("PRODUCT-1");
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
                input: { id: criterion.id, title: "Шаг 1" },
                as: "first",
              },
              {
                op: "task.criterion.update",
                ref: task.id,
                ifRevision: { $revision: "first" },
                input: { id: criterion.id, title: "Шаг 2" },
              },
            ],
          },
          { actor: "left", operationKey: "two-parent-steps" },
        );
        const source = first.getReplicationOutbox()[0];
        const steps = source?.transitions?.flatMap((step) =>
          step.components.filter((part) => part.after.kind === "task-criterion"),
        );
        const net = source?.components?.find((part) => part.after.kind === "task-criterion");
        if (
          steps?.length !== 2 ||
          steps[0] === undefined ||
          steps[1] === undefined ||
          net?.before === null ||
          net === undefined
        ) {
          throw new Error("Нет двух последовательных границ");
        }
        expect(steps[1].after.parents).toEqual([steps[0].after.version]);
        expect(net.after.parents).not.toContain(net.before.version);
        const peerTask = new TasksService(second).get(task.id);
        await new TasksService(second).criterion(
          task.id,
          "update",
          { id: criterion.id, description: "Удалённое описание" },
          { actor: "right", ifRevision: peerTask.revision },
        );
        const peer = new ReplicationService(second);
        const published = peer.prepare(remote).snapshot;
        peer.accept(published);

        const merged = new ReplicationService(first).prepare(published);

        expect(merged.conflicts).toEqual([]);
        peer.accept(merged.snapshot);
        expect(new TasksService(second).get(task.id).data.acceptanceCriteria[0]).toMatchObject({
          id: criterion.id,
          title: "Шаг 2",
          description: "Удалённое описание",
        });
        const final = merged.snapshot.components?.find((part) => part.kind === "task-criterion");
        expect(final?.parents).toHaveLength(2);
        expect(final?.parents).toContain(steps[1].after.version);
        expect(second.getBatchReceipt("two-parent-steps")).toBeDefined();
      },
    );
  });
});
