import { describe, expect, test } from "bun:test";
import { BatchService, TasksService } from "@relay/core";
import { decodeSnapshot } from "../../src/snapshot/codec";
import { git, requireGit } from "../../src/transport/git";
import { observeExchangeDatabase } from "./helpers/crash-exchange-state";
import { withTeamFixture } from "./team-helpers/team-fixture";
import {
  comparableSnapshot,
  expectAcknowledged,
  publishedSnapshot,
  storedEntity,
} from "./team-helpers/team-state";
import type { TeamReplica } from "./team-helpers/team-fixture.types";

const BODY = "# Durable\r\n\tТочный текст ё и e\u0301  \nбез финального LF";
const COMMENT = "Сохранить единственный комментарий\r\n**Авария не повторяет команду**";
const LATE_SUMMARY = "Поздний pending после materialization, до push";

/**
 * Читает фактические private refs новым Git-вызовом, минуя cache экземпляра repository.
 */
async function actualHeads(replica: TeamReplica): Promise<string[]> {
  return requireGit(
    await git(
      replica.repository.options.directory,
      ["rev-parse", "refs/heads/data", "refs/relay/accepted", "refs/relay/remote"],
      replica.repository.options,
    ),
    "crash-checkpoints",
  ).split("\n");
}

describe("Crash recovery durable стыка Git и SQLite", () => {
  test("A/B/C сохраняют исходный пакет, late pending и версии при отставшем Git accepted cursor", async () => {
    await withTeamFixture(async (team) => {
      const reader = await team.replica();
      const task = await new TasksService(reader.db).create({ title: "Общая задача" }, "seed");
      const seedChanges = reader.db.getReplicationOutbox();
      await reader.engine.run();
      const baseline = await publishedSnapshot(reader);
      const baselineHead = await team.originGit(["rev-parse", `refs/heads/${team.branch}`]);
      const writer = await team.replica(baseline);
      await writer.engine.run();
      const replicaId = writer.replication.status().replicaId;
      const operationKey = "crash-original-atomic";
      const result = await new BatchService(writer.db).execute(
        {
          version: 1,
          operations: [
            {
              op: "document.create",
              input: {
                name: "Исходный документ",
                body: BODY,
                relations: [{ target: { kind: "task", id: task.id }, type: "documents" }],
              },
            },
            { op: "task.comment.add", ref: task.id, input: { body: COMMENT } },
          ],
        },
        { actor: "original-author", operationKey },
      );
      const [original] = writer.db.getReplicationOutbox();
      const documentId = result.items[0]?.id;
      const comment = new TasksService(writer.db).comments(task.id)[0];
      if (!original || !documentId || !comment || !original.receipts[0]) {
        throw new Error("Не создан исходный атомарный пакет с документом, receipt и комментарием");
      }
      const initial = observeExchangeDatabase(writer.db, writer.replication);
      const document = writer.db.get(documentId);
      if (!document) {
        throw new Error("Не сохранён документ исходного пакета");
      }
      expect(initial.outbox).toEqual([original]);
      expect(comment).toMatchObject({ body: COMMENT, createdBy: "original-author" });
      expect(original.receipts[0].operationKey).toBe(operationKey);
      expect(JSON.parse(original.receipts[0].resultJson)).toEqual(result);
      expect(
        initial.snapshot.components?.filter(
          (part) => part.ownerId === documentId && part.kind === "document-relation",
        ),
      ).toMatchObject([
        {
          kind: "document-relation",
          deleted: false,
          value: { target: { kind: "task", id: task.id }, type: "documents" },
        },
      ]);

      // A: process.exit после durable Git commit, до первой попытки push.
      const committed = await team.exchangeInProcess(writer, { point: "before-push" });

      expect(observeExchangeDatabase(writer.db, writer.replication)).toEqual(committed.state);
      expect(committed.state).toEqual(initial);
      expect(writer.replication.status().replicaId).toBe(replicaId);
      expect(committed.lateChange).toBeNull();
      expect(committed.head).not.toBe(baselineHead);
      expect(await actualHeads(writer)).toEqual([committed.head, baselineHead, baselineHead]);
      expect(await team.originGit(["rev-parse", `refs/heads/${team.branch}`])).toBe(baselineHead);
      const candidate = decodeSnapshot(await writer.repository.files(committed.head));
      expect(candidate.publication?.changes.map((entry) => entry.source)).toEqual([original]);
      expectAcknowledged(candidate, original, true);
      expectAcknowledged(await publishedSnapshot(reader), original, false);
      expectAcknowledged(writer.replication.capture(), original, false);
      expect(new BatchService(writer.db).getResult(operationKey)).toEqual({
        ...result,
        replayed: true,
      });

      // B: новый процесс фиксирует конкурентную команду и погибает после настоящего успешного push.
      const pushed = await team.exchangeInProcess(writer, {
        point: "after-push",
        lateCommand: {
          op: "document.update",
          ref: documentId,
          ifRevision: document.revision,
          input: { summary: LATE_SUMMARY },
        },
      });

      const late = pushed.lateChange;
      if (!late) {
        throw new Error("Не зафиксирована поздняя команда между commit и push");
      }
      expect(pushed.pid).not.toBe(committed.pid);
      expect(observeExchangeDatabase(writer.db, writer.replication)).toEqual(pushed.state);
      expect(pushed.state.outbox).toEqual([original, late]);
      expect(pushed.state.base).toEqual(initial.base);
      expect(await actualHeads(writer)).toEqual([pushed.head, baselineHead, baselineHead]);
      expect(await team.originGit(["rev-parse", `refs/heads/${team.branch}`])).toBe(pushed.head);
      const acceptedByOrigin = await publishedSnapshot(reader);
      expect(acceptedByOrigin.publication?.changes.map((entry) => entry.source)).toEqual([
        original,
      ]);
      expectAcknowledged(acceptedByOrigin, original, true);
      expectAcknowledged(acceptedByOrigin, late, false);
      expectAcknowledged(writer.replication.capture(), original, false);
      expect(storedEntity(acceptedByOrigin, documentId).record.data).toMatchObject({
        body: BODY,
        summary: "",
      });
      expect(acceptedByOrigin.components).toEqual(initial.snapshot.components);
      expect(acceptedByOrigin.comments).toEqual(initial.snapshot.comments);
      expect(acceptedByOrigin.receipts).toEqual([original.receipts[0]]);

      // C: production recovery нового процесса уже committed SQLite accept, но ещё не update-ref.
      const accepted = await team.exchangeInProcess(writer, {
        point: "after-accept",
        acceptHead: pushed.head,
      });

      if (accepted.state.base === null) {
        throw new Error("Core accept не сохранил durable base");
      }
      expect(accepted.beforePush).toBeNull();
      expect(accepted.state.outbox).toEqual([late]);
      expect(observeExchangeDatabase(writer.db, writer.replication)).toEqual(accepted.state);
      expect(accepted.state.base).toEqual(acceptedByOrigin);
      expect(await actualHeads(writer)).toEqual([pushed.head, baselineHead, baselineHead]);
      expect(await team.originGit(["rev-parse", `refs/heads/${team.branch}`])).toBe(pushed.head);
      expectAcknowledged(accepted.state.snapshot, original, true);
      expectAcknowledged(accepted.state.base, late, false);
      expect(writer.db.get(documentId)?.data).toMatchObject({ body: BODY, summary: LATE_SUMMARY });
      expect(new TasksService(writer.db).comments(task.id)).toEqual([comment]);
      expect(new BatchService(writer.db).getResult(operationKey)).toEqual({
        ...result,
        replayed: true,
      });

      const recovered = await team.exchangeInProcess(writer, { point: "complete" });

      // Старый Git cursor требует replay history, но не повторного изменения SQLite до следующего push.
      expect(recovered.beforePush).toEqual(accepted.state);
      expect(new Set([committed.pid, pushed.pid, accepted.pid, recovered.pid]).size).toBe(4);
      expect(recovered.head).not.toBe(pushed.head);
      expect(recovered.state.outbox).toEqual([]);
      expect(writer.replication.status().replicaId).toBe(replicaId);
      expect(observeExchangeDatabase(writer.db, writer.replication)).toEqual(recovered.state);
      expect(await actualHeads(writer)).toEqual([recovered.head, recovered.head, recovered.head]);
      const published = await publishedSnapshot(writer);
      expect(published.publication?.changes.map((entry) => entry.source)).toEqual([late]);
      expect(storedEntity(published, documentId).record.data).toMatchObject({
        body: BODY,
        summary: LATE_SUMMARY,
      });
      expect(published.components).toEqual(initial.snapshot.components);
      expect(published.comments).toEqual(initial.snapshot.comments);
      expect(published.receipts).toEqual([original.receipts[0]]);
      for (const change of [...seedChanges, original, late]) {
        expectAcknowledged(published, change, true);
      }
      expect(
        published.confirmations
          .flatMap((entry) =>
            (entry.proofs ?? []).map((proof) => `${entry.replicaId}:${proof.sequence}`),
          )
          .sort(),
      ).toEqual([...seedChanges, original, late].map((entry) => entry.id).sort());
      await reader.engine.run();
      await writer.engine.run();
      expect(comparableSnapshot(reader.replication.capture())).toEqual(
        comparableSnapshot(published),
      );
      expect(new TasksService(reader.db).comments(task.id)).toEqual([comment]);
      expect(new BatchService(reader.db).getResult(operationKey)).toEqual({
        ...result,
        replayed: true,
      });
      const beforeReader = observeExchangeDatabase(reader.db, reader.replication);
      const beforeWriter = observeExchangeDatabase(writer.db, writer.replication);

      await writer.engine.run();
      await reader.engine.run();
      await writer.engine.run();

      expect(observeExchangeDatabase(reader.db, reader.replication)).toEqual(beforeReader);
      expect(observeExchangeDatabase(writer.db, writer.replication)).toEqual(beforeWriter);
      expect(await team.originGit(["rev-parse", `refs/heads/${team.branch}`])).toBe(recovered.head);
      expect(await team.originGit(["rev-list", "--count", `refs/heads/${team.branch}`])).toBe("3");
      expect(await team.originGit(["for-each-ref", "--format=%(refname)"])).toBe(
        `refs/heads/${team.branch}`,
      );
    });
  }, 30_000);
});
