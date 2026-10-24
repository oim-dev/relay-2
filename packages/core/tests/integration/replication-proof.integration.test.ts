import { describe, expect, test } from "bun:test";
import { portableEntity } from "@relay/storage";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { ReplicationService } from "../../src/replication/replication";
import { validateReplicationHistory } from "../../src/replication/replication-format";
import { ValidatedReplicationHistory } from "../../src/replication/replication-history-proof";
import { withReplicationFixture } from "./helpers/replication-fixture";
import { unverifiedPublication } from "./helpers/replication-publication-fixture";

describe("Core-owned immutable history proof", () => {
  test("reuse сохраняет позднюю запись, а поддельный token и другой target не разрешают импорт", async () => {
    await withReplicationFixture(
      async (db) => {
        await new KnowledgeService(db).create("document", { name: "Общий", body: "До" }, "seed");
      },
      async ({ first, second, remote }) => {
        const doc = new KnowledgeService(first).get("document", "DOC-1");
        await new KnowledgeService(first).update(
          "document",
          doc.id,
          { body: "Удалённый" },
          { actor: "remote", ifRevision: doc.revision },
        );
        const candidate = new ReplicationService(first).prepare(remote).snapshot;
        const input = structuredClone(candidate);
        const proof = validateReplicationHistory(remote, input);
        expect(Object.isFrozen(proof.snapshot)).toBe(true);
        expect(Object.isFrozen(proof.snapshot.entities[0]?.record.data)).toBe(true);
        expect(Object.isFrozen(input)).toBe(false);
        const late = await new KnowledgeService(second).create(
          "document",
          { name: "Поздняя", body: "Не потерять" },
          "local",
        );
        const reader = new ReplicationService(second);

        reader.accept(proof.snapshot, proof);

        expect(second.get(doc.id)?.data.body).toBe("Удалённый");
        expect(second.get(late.id)?.data.body).toBe("Не потерять");
        expect(reader.status().pending).toBe(1);
        const before = reader.capture();
        const forged = new ValidatedReplicationHistory(proof.snapshot);
        expect(() => reader.accept(proof.snapshot, forged)).toThrow(
          expect.objectContaining({ code: "REPLICATION_PUBLICATION_REQUIRED" }),
        );
        const changed = {
          ...candidate,
          entities: candidate.entities.map((entry) =>
            entry.record.id === doc.id
              ? portableEntity(
                  { ...entry.record, data: { ...entry.record.data, body: "Подмена" } },
                  [entry.version],
                )
              : entry,
          ),
        };
        expect(() => reader.accept(changed, proof)).toThrow(
          expect.objectContaining({ code: "REPLICATION_PUBLICATION_REQUIRED" }),
        );
        expect(reader.capture()).toEqual(before);
        expect(reader.status().pending).toBe(1);
      },
    );
  });

  test("непроверенный prefix перед declared base не становится основанием capability", async () => {
    await withReplicationFixture(
      async (db) => {
        await new KnowledgeService(db).create("product", { name: "Паспорт" }, "seed");
        await new KnowledgeService(db).create("document", { name: "Документ", body: "До" }, "seed");
      },
      ({ second, remote }) => {
        const product = remote.entities.find((entry) => entry.record.kind === "product");
        const doc = remote.entities.find((entry) => entry.record.kind === "document");
        if (product === undefined || doc === undefined) {
          throw new Error("Нет исходных записей");
        }
        const timestamp = "2026-10-24T00:00:00.000Z";
        const changedProduct = portableEntity(
          {
            ...product.record,
            updatedBy: "publisher",
            updatedAt: timestamp,
            data: { ...product.record.data, name: "Запрещённый второй create" },
          },
          [product.version],
        );
        const fork = unverifiedPublication(remote, product, changedProduct, "product.create");
        const changedDoc = portableEntity(
          {
            ...doc.record,
            updatedBy: "publisher",
            updatedAt: timestamp,
            data: { ...doc.record.data, body: "После fork" },
          },
          [doc.version],
        );
        const target = unverifiedPublication(fork, doc, changedDoc, "document.update", 2);
        // Caller назвал fork уже принятым; проверен лишь fork→target, а prefix содержит реальную SQLite base.
        const proof = validateReplicationHistory(fork, target, { chain: [remote, fork, target] });
        const reader = new ReplicationService(second);
        const before = reader.capture();

        expect(() => reader.accept(proof.snapshot, proof)).toThrow(
          expect.objectContaining({ code: "REPLICATION_PUBLICATION_REQUIRED" }),
        );
        expect(() => validateReplicationHistory(remote, target, { chain: [fork] })).toThrow(
          expect.objectContaining({ code: "ALREADY_EXISTS" }),
        );

        expect(reader.capture()).toEqual(before);
        expect(second.getReplicationState().base).toEqual(remote);
      },
    );
  });
});
