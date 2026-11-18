import { describe, expect, test } from "bun:test";
import { KnowledgeService } from "@relay/core";
import { resolveKeyConflictRequest } from "../../src/app/key-conflicts";
import { GIT_FIXTURE_DRAIN_MS, withGitFixture } from "./helpers/git-fixture";
import { gitFixtureDeadlines } from "./helpers/git-fixture-budgets";

const deadlineMs = gitFixtureDeadlines.exchange;

describe("Явное назначение ключей при обмене Git-реплик", () => {
  test(
    "две разные записи с одним ключом сохраняются после выбора номера без слияния содержания",
    async () => {
      await withGitFixture(
        async (fixture) => {
          fixture.phase("prepare/shared-project");
          const first = await fixture.replica("first");
          await first.engine.run();
          const second = await fixture.replica("second", first);
          const firstKnowledge = new KnowledgeService(first.db);
          const secondKnowledge = new KnowledgeService(second.db);
          const published = await firstKnowledge.create(
            "document",
            { name: "Первый документ", body: "Текст первого автора." },
            "first-author",
          );
          const local = await secondKnowledge.create(
            "document",
            { name: "Другой документ", body: "Самостоятельный текст второго автора." },
            "second-author",
          );
          expect(published.id).not.toBe(local.id);
          expect(published.key).toBe(local.key);

          fixture.phase("act/detect-key-collision");
          await first.engine.run();
          await second.engine.run();
          const conflicts = second.replication.keyConflicts();
          expect(conflicts).toHaveLength(1);
          const conflict = conflicts[0];
          if (!conflict) {
            throw new Error("Ожидалась коллизия двух независимо созданных документов");
          }
          expect(conflict.collisions).toHaveLength(1);
          expect(conflict.collisions[0]).toMatchObject({
            entityId: local.id,
            key: published.key,
            acceptedOwnerId: published.id,
          });
          expect(secondKnowledge.get("document", local.id)).toEqual(local);
          const pending = second.replication.status().pending;
          const input = {
            id: conflict.id,
            actor: "second-author",
            decision: {
              fingerprint: conflict.fingerprint,
              assignments: [{ entityId: local.id, key: "DOC-43" }],
            },
          };

          fixture.phase("act/choose-key-and-repeat-request");
          const resolved = resolveKeyConflictRequest(second.replication, input);
          resolveKeyConflictRequest(second.replication, input);

          expect(resolved.id).toBe(conflict.id);
          expect(resolved.included).toContain(conflict.id);
          expect(second.replication.status().pending).toBe(pending);

          fixture.phase("act/publish-explicit-assignment");
          await second.engine.run();
          await first.engine.run();

          for (const knowledge of [firstKnowledge, secondKnowledge]) {
            expect(knowledge.get("document", published.id)).toMatchObject({
              id: published.id,
              key: published.key,
              createdBy: "first-author",
              data: published.data,
            });
            expect(knowledge.get("document", local.id)).toMatchObject({
              id: local.id,
              key: "DOC-43",
              createdBy: "second-author",
              data: local.data,
            });
            expect(knowledge.get("document", published.key).id).toBe(published.id);
            expect(knowledge.get("document", "DOC-43").id).toBe(local.id);
          }
          expect(first.db.count("document")).toBe(2);
          expect(second.db.count("document")).toBe(2);
          expect(first.replication.status().pending).toBe(0);
          expect(second.replication.status().pending).toBe(0);

          fixture.phase("assert/replay-after-acceptance-without-echo");
          const before = second.replication.capture();
          resolveKeyConflictRequest(second.replication, input);
          expect(second.replication.capture()).toEqual(before);
          expect(second.replication.status().pending).toBe(0);
          expect(second.replication.keyConflicts()).toEqual([]);
        },
        "database-redesign/git-key-resolution",
        { name: "explicit-key-resolution", deadlineMs },
      );
    },
    deadlineMs + GIT_FIXTURE_DRAIN_MS,
  );
});
