import { describe, expect, spyOn, test } from "bun:test";
import { KnowledgeService } from "@relay/core";
import type { ReplicationHistoryInput } from "@relay/contracts";
import { withGitFixture } from "./helpers/git-fixture";
import { readPublicationHistory } from "../../src/sync/publication-reader";
import { decodeSnapshot, encodeSnapshot } from "../../src/snapshot/codec";
import { validateSnapshotHistory } from "../../src/sync/replication-adapter";
import { requireGit } from "../../src/transport/git";

describe("Полная проверка history ограниченными Core batches", () => {
  test("один Core validation получает все промежуточные публикации, без повторного base decode для каждого шага", async () => {
    await withGitFixture(async (fixture) => {
      const writer = await fixture.replica("batch-writer");
      await writer.engine.run();
      const reader = await fixture.replica("batch-reader", writer);
      await reader.engine.run();
      const publications: string[] = [];
      for (let index = 0; index < 4; index++) {
        await new KnowledgeService(writer.db).create(
          "document",
          { name: `Документ ${index}`, body: `текст ${index}` },
          "author",
        );
        await writer.engine.run();
        const publication = writer.replication.acceptedSnapshot()?.publication?.publicationId;
        if (!publication) {
          throw new Error("missing publication");
        }
        publications.push(publication);
      }
      const head = await reader.repository.fetch();
      if (!head) {
        throw new Error("missing remote");
      }
      const histories: ReplicationHistoryInput[] = [];

      const snapshot = await readPublicationHistory(
        reader.repository,
        head,
        {
          decode: decodeSnapshot,
          validate: (base, remote, history = {}) => {
            histories.push(history);
            return validateSnapshotHistory(base, remote, history);
          },
        },
        { projectId: reader.db.projectId, base: reader.replication.acceptedSnapshot() },
      );

      expect(histories).toHaveLength(1);
      expect(histories[0]?.chain?.map((entry) => entry.publication?.publicationId)).toEqual(
        publications,
      );
      expect(snapshot.entities.filter((entry) => entry.record.kind === "document")).toHaveLength(4);
      expect(reader.db.list("document")).toHaveLength(0);
      const acceptance = spyOn(reader.replication, "accept");
      const capture = spyOn(reader.db, "captureReplication");
      const imports = spyOn(reader.db, "importReplication");
      try {
        await reader.engine.run();

        expect(acceptance).toHaveBeenCalledTimes(1);
        const call = acceptance.mock.calls[0];
        if (!call) {
          throw new Error("missing acceptance");
        }
        const authority = call[1];
        expect(authority && "snapshot" in authority ? authority.snapshot : null).toBe(call[0]);
        expect(Object.isFrozen(call[0])).toBe(true);
        expect(Object.isFrozen(call[0].entities)).toBe(true);
        // Core может переиспользовать clean snapshot по полному guard; больше одного capture на page не нужно.
        expect(capture.mock.calls.length).toBeLessThanOrEqual(1);
        expect(imports).toHaveBeenCalledTimes(1);
        expect(
          reader.db
            .list("document")
            .map((entry) => entry.data.body)
            .sort(),
        ).toEqual(["текст 0", "текст 1", "текст 2", "текст 3"]);
        expect(reader.replication.status().pending).toBe(0);
      } finally {
        acceptance.mockRestore();
        capture.mockRestore();
        imports.mockRestore();
      }
    });
  }, 25_000);

  test("валидный tip не скрывает inserted capture/null publication в фактической Git ancestry", async () => {
    await withGitFixture(async (fixture) => {
      const writer = await fixture.replica("bad-writer");
      await writer.engine.run();
      const reader = await fixture.replica("bad-reader", writer);
      await reader.engine.run();
      const base = writer.replication.acceptedSnapshot();
      const beforeHead = await writer.repository.acceptedCommit();
      if (!base || !beforeHead) {
        throw new Error("missing trusted base");
      }
      await new KnowledgeService(writer.db).create(
        "document",
        { name: "Новая запись", body: "tip корректен сам по себе" },
        "author",
      );
      const prepared = writer.replication.prepare(base).snapshot;
      const inserted = await writer.repository.commit(
        encodeSnapshot(writer.replication.capture()),
        beforeHead,
      );
      const head = await writer.repository.commit(encodeSnapshot(prepared), inserted);
      requireGit(await writer.repository.push(head), "fixture-invalid-parent");

      await expect(reader.engine.run()).rejects.toMatchObject({ code: "GIT_PUBLICATION_REQUIRED" });

      expect(reader.db.list("document")).toHaveLength(0);
      expect(await reader.repository.acceptedCommit()).toBe(beforeHead);
    });
  }, 20_000);
});
