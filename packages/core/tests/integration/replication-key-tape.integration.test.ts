import { describe, expect, test } from "bun:test";
import { ProjectDatabase } from "@relay/storage";
import { join } from "node:path";
import { BatchService } from "../../src/batch/batch";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { ReplicationService } from "../../src/replication/replication";
import { withReplicationFixture } from "./helpers/replication-fixture";

const cases = [
  {
    name: "одна промежуточная коллизия разрешается сокращённым вводом",
    middle: [],
    replacements: [{ fromKey: "DOC-1", key: "DOC-10" }],
    implicit: true,
  },
  {
    name: "две промежуточные коллизии одного ID требуют fromKey",
    middle: ["DOC-2"],
    replacements: [
      { fromKey: "DOC-1", key: "DOC-10" },
      { fromKey: "DOC-2", key: "DOC-11" },
    ],
    implicit: false,
  },
] as const;

describe("Ключевые решения исходной command tape", () => {
  test.each(cases)(
    "$name, сохраняя конечный rename и первоначальную квитанцию",
    async ({ middle, replacements, implicit }) => {
      await withReplicationFixture(
        () => {},
        async ({ first, second, remote, directory }) => {
          const body = "DOC-1 и DOC-2 — дословные ссылки в тексте";
          const result = await new BatchService(first).execute(
            {
              version: 1,
              operations: [
                { op: "document.create", as: "created", input: { name: "Локальный", body } },
                {
                  op: "document.update",
                  as: "noop",
                  ref: { $ref: "created" },
                  ifRevision: { $revision: "created" },
                  input: { body },
                },
                ...[...middle, "DOC-9"].map((key, index) => ({
                  op: "document.rename",
                  as: `renamed${index}`,
                  ref: { $ref: "created" },
                  ifRevision: { $revision: index === 0 ? "noop" : `renamed${index - 1}` },
                  input: { key },
                })),
              ],
            },
            { actor: "left", operationKey: "key-tape" },
          );
          const id = result.items[0]?.id;
          const source = first.getReplicationOutbox()[0];
          if (id === undefined || source === undefined) {
            throw new Error("Нет исходного batch");
          }
          const original = new KnowledgeService(first).get("document", id);
          const receipt = first.getBatchReceipt("key-tape");
          const foreign = new KnowledgeService(second);
          const winners = [];
          for (const replacement of replacements) {
            winners.push(
              await foreign.create(
                "document",
                { name: replacement.fromKey, body: "Принят первым" },
                "right",
              ),
            );
          }
          const peer = new ReplicationService(second);
          const published = peer.prepare(remote).snapshot;
          peer.accept(published);
          const sync = new ReplicationService(first);

          const prepared = sync.prepare(published);

          expect(prepared.conflicts.map((entry) => entry.code)).toEqual([
            "REPLICATION_KEY_COLLISION",
          ]);
          const conflict = sync.keyConflicts()[0];
          if (conflict === undefined) {
            throw new Error("Коллизии промежуточных ключей отсутствуют");
          }
          expect(conflict.collisions.map((entry) => entry.key)).toEqual(
            replacements.map((entry) => entry.fromKey),
          );
          expect(conflict.collisions.every((entry) => entry.entityId === id)).toBe(true);
          if (!implicit) {
            expect(() =>
              sync.resolveKeys(
                conflict.id,
                {
                  fingerprint: conflict.fingerprint,
                  assignments: [{ entityId: id, key: "DOC-10" }],
                },
                "resolver",
              ),
            ).toThrow(expect.objectContaining({ code: "REPLICATION_RESOLUTION_SCOPE" }));
            expect(first.getReplicationDecision(conflict.id)).toBeUndefined();
          }
          const input = {
            fingerprint: conflict.fingerprint,
            assignments: replacements.map((entry) => ({
              entityId: id,
              key: entry.key,
              ...(implicit ? {} : { fromKey: entry.fromKey }),
            })),
          };

          const resolved = sync.resolveKeys(conflict.id, input, "resolver");

          expect(resolved.conflicts).toEqual([]);
          expect(resolved.included).toEqual([source.id]);
          expect(resolved.snapshot.publication?.changes[0]?.source).toEqual(source);
          expect(first.getReplicationOutbox()).toEqual([source]);
          expect(first.getBatchReceipt("key-tape")).toEqual(receipt);
          const guard = first.getReplicationGuard();
          expect(
            sync.resolveKeys(
              conflict.id,
              {
                fingerprint: conflict.fingerprint,
                assignments: [...replacements]
                  .reverse()
                  .map((entry) => ({ entityId: id, ...entry })),
              },
              "resolver",
            ).snapshot,
          ).toEqual(resolved.snapshot);
          expect(first.getReplicationGuard()).toEqual(guard);
          sync.accept(resolved.snapshot);
          peer.accept(resolved.snapshot);

          for (const database of [first, second]) {
            const read = new KnowledgeService(database);
            expect(read.get("document", id)).toMatchObject({
              id,
              key: "DOC-9",
              data: original.data,
              createdAt: original.createdAt,
              createdBy: original.createdBy,
              updatedAt: original.updatedAt,
              updatedBy: original.updatedBy,
            });
            for (const replacement of replacements) {
              expect(read.get("document", replacement.key).id).toBe(id);
            }
            for (const winner of winners) {
              expect(read.get("document", winner.key).id).toBe(winner.id);
            }
            expect(new BatchService(database).getResult("key-tape")).toEqual({
              ...result,
              replayed: true,
            });
            expect(database.getBatchReceipt("key-tape")).toEqual(receipt);
            expect(new ReplicationService(database).status().pending).toBe(0);
          }
          const restored = ProjectDatabase.createReplica(
            join(directory, "key-tape.sqlite"),
            first.projectId,
          );
          try {
            new ReplicationService(restored).bootstrap(
              JSON.parse(JSON.stringify(resolved.snapshot)),
              {
                chain: [remote, published],
              },
            );
            expect(restored.get(id)?.key).toBe("DOC-9");
            for (const replacement of replacements) {
              expect(restored.get(replacement.key)?.id).toBe(id);
            }
            expect(new BatchService(restored).getResult("key-tape")).toEqual({
              ...result,
              replayed: true,
            });
          } finally {
            restored.close();
          }
        },
      );
    },
  );
});
