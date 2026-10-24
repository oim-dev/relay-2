import { describe, expect, test } from "bun:test";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { ReplicationService } from "../../src/replication/replication";
import { withBoundedPublicationFixture } from "./helpers/bounded-publication-fixture";

const budget = { maxChangesets: 2, maxBytes: 1024 * 1024 };

describe("Ограниченная публикация сохранённого решения", () => {
  test("scoped witness учитывает поздний source вне окна, retry сохраняет resolution и хвост публикуется отдельно", async () => {
    await withBoundedPublicationFixture(
      async (db) => {
        await new KnowledgeService(db).create("document", { name: "Общий", body: "До" }, "seed");
      },
      async ({ first, second, remote }) => {
        const knowledge = new KnowledgeService(first);
        const original = knowledge.get("document", "DOC-1");
        const edited = await knowledge.update(
          "document",
          original.id,
          { body: "Локальный" },
          {
            actor: "left",
            ifRevision: original.revision,
          },
        );
        const independent = await knowledge.create(
          "document",
          { name: "Независимый", body: "Текст" },
          "left",
        );
        await knowledge.update(
          "document",
          original.id,
          { summary: "Поздний остаток" },
          {
            actor: "left",
            ifRevision: edited.revision,
          },
        );
        const [conflicting, ready, later] = first.getReplicationOutbox();
        if (!conflicting || !ready || !later) {
          throw new Error("Нет трёх sources");
        }
        await new KnowledgeService(second).update(
          "document",
          original.id,
          { body: "Удалённый" },
          {
            actor: "right",
            ifRevision: original.revision,
          },
        );
        const consumer = new ReplicationService(second);
        const incoming = consumer.prepare(remote).snapshot;
        consumer.accept(incoming);
        const writer = new ReplicationService(first);
        writer.accept(incoming);
        const conflict = writer.conflicts()[0];
        if (conflict === undefined) {
          throw new Error("Нет конфликта");
        }

        const resolved = writer.resolve(
          conflict.id,
          {
            fingerprint: conflict.fingerprint,
            choice: "local",
          },
          "resolver",
          { budget },
        );

        expect(resolved.included).toEqual([conflicting.id, ready.id]);
        expect(resolved.selection).toMatchObject({
          pending: 3,
          hasMore: true,
          nextSequence: ready.sequence,
        });
        const decision = resolved.snapshot.publication?.changes[0]?.resolution;
        if (decision == null) {
          throw new Error("Нет проверенного решения");
        }
        expect(decision).toMatchObject({ changesetId: conflicting.id, choice: "local" });
        expect(first.getReplicationDecisions()[0]?.localSources).toEqual(
          [
            {
              id: conflicting.id,
              digest: conflicting.digest,
              resolutionId: decision.resolutionId,
            },
            { id: later.id, digest: later.digest, resolutionId: null },
          ].sort((a, b) => (a.id < b.id ? -1 : 1)),
        );
        // Own deterministic overlay меняет версии, но не состав scoped witness и не авторство решения.
        writer.accept(incoming);
        const retry = writer.prepare(incoming, {}, { budget });
        expect(retry.conflicts).toEqual([]);
        expect(retry.included).toEqual([conflicting.id, ready.id]);
        expect(retry.snapshot.publication?.changes[0]?.resolution).toEqual(decision);
        expect(writer.prepare(incoming, {}, { budget }).snapshot.publication?.publicationId).toBe(
          retry.snapshot.publication?.publicationId,
        );

        writer.accept(retry.snapshot);
        consumer.accept(retry.snapshot);

        expect(first.getReplicationOutbox()).toEqual([later]);
        expect(first.get(original.id)?.data).toMatchObject({
          body: "Локальный",
          summary: "Поздний остаток",
        });
        expect(second.get(original.id)?.data).toMatchObject({ body: "Локальный", summary: "" });
        expect(second.get(independent.id)?.data.body).toBe("Текст");
        const tail = writer.prepare(
          retry.snapshot,
          {},
          { afterSequence: retry.selection.nextSequence, budget },
        );
        expect(tail.included).toEqual([later.id]);
        expect(tail.snapshot.publication?.changes[0]?.source).toEqual(later);
        writer.accept(tail.snapshot);
        consumer.accept(tail.snapshot);
        expect(writer.status().pending).toBe(0);
        expect(consumer.status().pending).toBe(0);
        expect(second.get(original.id)?.data).toMatchObject({
          body: "Локальный",
          summary: "Поздний остаток",
        });
      },
    );
  });
});
