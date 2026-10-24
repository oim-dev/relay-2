import { describe, expect, test } from "bun:test";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { ReplicationService } from "../../src/replication/replication";
import { withReplicationFixture } from "./helpers/replication-fixture";

const collisions = [
  {
    name: "суффикс 2^53",
    key: "DOC-9007199254740992",
    occupied: "DOC-9007199254740993",
    expected: "DOC-9007199254740994",
  },
  {
    name: "перенос разряда за точностью Number",
    key: "DOC-999999999999999999999999999999",
    occupied: "DOC-1000000000000000000000000000000",
    expected: "DOC-1000000000000000000000000000001",
  },
] as const;

describe("Коллизии больших допустимых ключей", () => {
  test.each(collisions)(
    "$name продвигается до свободного ключа без смены ID и чужого alias",
    async ({ key, occupied, expected }) => {
      await withReplicationFixture(
        async (db) => {
          const knowledge = new KnowledgeService(db);
          await knowledge.create("document", { name: "Локальный", body: "A" }, "seed");
          await knowledge.create("document", { name: "Удалённый", body: "B" }, "seed");
          const blocker = await knowledge.create(
            "document",
            { name: "Занятый сосед", body: "C" },
            "seed",
          );
          await knowledge.rename("document", blocker.id, occupied, {
            actor: "seed",
            ifRevision: blocker.revision,
          });
        },
        async ({ first, second, remote }) => {
          const left = new KnowledgeService(first);
          const right = new KnowledgeService(second);
          const local = left.get("document", "DOC-1");
          const remoteDocument = right.get("document", "DOC-2");
          const blocker = left.get("document", occupied);
          await left.rename("document", local.id, key, {
            actor: "left",
            ifRevision: local.revision,
          });
          await right.rename("document", remoteDocument.id, key, {
            actor: "right",
            ifRevision: remoteDocument.revision,
          });
          const sync = new ReplicationService(first);
          const peer = new ReplicationService(second);
          const published = peer.prepare(remote);
          expect(published.conflicts).toEqual([]);
          peer.accept(published.snapshot);
          const pending = first.getReplicationOutbox();

          const accepted = sync.accept(published.snapshot);

          expect(accepted.reconciled).toBe(true);
          expect(left.get("document", local.id)).toMatchObject({
            id: local.id,
            key: expected,
            data: { body: "A" },
          });
          expect(left.get("document", key)).toMatchObject({
            id: remoteDocument.id,
            key,
            data: { body: "B" },
          });
          expect(left.get("document", occupied)).toMatchObject({
            id: blocker.id,
            key: occupied,
            data: { body: "C" },
          });
          expect(first.getReplicationOutbox()).toEqual(pending);
          expect(first.getReplicationState().base).toEqual(published.snapshot);
          expect(sync.capture().addresses.filter((entry) => entry.ref === key)).toEqual([
            { ref: key, entityId: remoteDocument.id },
          ]);
          expect(sync.capture().addresses.filter((entry) => entry.ref === expected)).toEqual([
            { ref: expected, entityId: local.id },
          ]);
          expect(sync.conflicts().map((entry) => entry.code)).toEqual(["REPLICATION_ADDRESS"]);
        },
      );
    },
  );
});
