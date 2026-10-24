import { describe, expect, test } from "bun:test";
import { KnowledgeService } from "@relay/core";
import { decodeSnapshot, encodeSnapshot } from "../../src/snapshot/codec";
import { SyncEngine } from "../../src/sync/engine";
import { git, requireGit } from "../../src/transport/git";
import { GIT_FIXTURE_DRAIN_MS, withGitFixture } from "./helpers/git-fixture";
import { encodeLayoutOneFixture } from "./helpers/layout-1-fixture";

const artifactGroup = "git-sync-implementation/finalization/windows-git-fixtures/fixtures";
const body = "\ufeff# Точный текст\r\n\tБез конечного LF  ";
const deadlineMs = 5_000;

describe("Граница миграции физического Git layout", () => {
  test(
    "настоящая публикация сохраняет DTO, версии и source digests в layout 1/2; mixed history не создаёт echo",
    async () => {
      await withGitFixture(
        async (fixture) => {
          fixture.phase("prepare/layout-one-publication");
          const first = await fixture.replica("layout-a");
          const knowledge = new KnowledgeService(first.db);
          const document = await knowledge.create(
            "document",
            { name: "До обновления", body },
            "Автор",
          );
          const original = first.replication.prepare(null).snapshot;
          const originalDocument = original.entities.find((item) => item.record.id === document.id);
          if (!original.publication || !originalDocument) {
            throw new Error("В fixture отсутствует Core публикация документа");
          }
          const legacyFiles = encodeLayoutOneFixture(original);
          const currentFiles = encodeSnapshot(original);
          const legacyDto = decodeSnapshot(legacyFiles);
          const currentDto = decodeSnapshot(currentFiles);

          fixture.phase("assert/layout-dto-identity");
          expect(legacyDto).toEqual(original);
          expect(currentDto).toEqual(original);
          expect(currentDto.entities.find((item) => item.record.id === document.id)?.version).toBe(
            originalDocument.version,
          );
          expect(currentDto.publication?.changes.map((change) => change.source.digest)).toEqual(
            original.publication.changes.map((change) => change.source.digest),
          );
          fixture.phase("act/publish-layout-one");
          const legacyHead = await first.repository.commit(legacyFiles, null);
          requireGit(await first.repository.push(legacyHead), "publish-legacy-fixture");
          await first.engine.run();
          expect(first.replication.status().pending).toBe(0);
          expect(await first.repository.ref("refs/heads/data")).toBe(legacyHead);

          // Новый owner повторно читает durable cursor и layout 1, не используя cache первого engine.
          fixture.phase("act/reopen-layout-one");
          await new SyncEngine(
            first.directory,
            first.db.projectId,
            first.replication,
            first.repository,
            fixture.signal,
          ).run();
          expect(await first.repository.ref("refs/heads/data")).toBe(legacyHead);
          expect(first.db.get(document.id)?.revision).toBe(document.revision);
          const second = await fixture.replica("layout-b", first);
          requireGit(
            await git(first.repository.options.directory, ["config", "core.autocrlf", "true"], {
              env: first.repository.options.env ?? {},
              signal: fixture.signal,
            }),
            "fixture-autocrlf",
          );

          fixture.phase("act/publish-layout-two");
          await knowledge.update(
            "document",
            document.id,
            { name: "После обновления", summary: "непарный:\ud800" },
            { actor: "Автор", ifRevision: document.revision },
          );
          await first.engine.run();
          const currentHead = await first.repository.ref("refs/heads/data");
          if (!currentHead) {
            throw new Error("Новая публикация fixture отсутствует");
          }
          fixture.phase("assert/layout-two-and-parent");
          const published = await first.repository.files(currentHead);
          expect(JSON.parse(Buffer.from(published.get("manifest.json") ?? []).toString())).toEqual({
            layoutVersion: 2,
            formatVersion: 1,
            modelVersion: 2,
            projectId: first.db.projectId,
          });
          const current = decodeSnapshot(published);
          expect(current.publication?.parent).toEqual({
            publicationId: original.publication.publicationId,
            snapshotDigest: original.publication.snapshotDigest,
          });
          expect(
            current.entities.find((item) => item.record.id === document.id)?.record.data,
          ).toMatchObject({
            name: "После обновления",
            body,
            summary: "непарный:\ud800",
          });

          // У второй реплики ещё нет accepted Git cursor: reader проверяет обе версии от genesis.
          fixture.phase("act/read-mixed-history");
          await second.engine.run();
          const beforeIdle = second.db.get(document.id);
          fixture.phase("act/idle-with-mixed-history");
          await first.engine.run();
          await second.engine.run();

          fixture.phase("assert/no-echo-and-legacy-bytes");
          expect(first.replication.capture()).toEqual(second.replication.capture());
          expect(second.db.get(document.id)).toEqual(beforeIdle);
          expect(second.db.get(document.id)?.data).toMatchObject({
            body,
            summary: "непарный:\ud800",
          });
          expect(first.replication.status().pending).toBe(0);
          expect(second.replication.status().pending).toBe(0);
          expect(await first.repository.ref("refs/heads/data")).toBe(currentHead);
          expect(await second.repository.ref("refs/heads/data")).toBe(currentHead);
          expect(await first.repository.history(currentHead, null)).toEqual([
            { head: legacyHead, parent: null },
            { head: currentHead, parent: legacyHead },
          ]);
          expect(await first.repository.files(legacyHead)).toEqual(legacyFiles);
        },
        artifactGroup,
        { name: "layout-mixed", deadlineMs },
      );
    },
    deadlineMs + GIT_FIXTURE_DRAIN_MS,
  );

  test.each([
    {
      name: "layout 1: предметная версия проверяется Core",
      diagnosticName: "layout-one-corrupt",
      encode: encodeLayoutOneFixture,
      code: "REPLICATION_FORMAT",
    },
    {
      name: "layout 2: digest проверяется до Core",
      diagnosticName: "layout-two-corrupt",
      encode: encodeSnapshot,
      code: "GIT_INVALID_SNAPSHOT",
    },
  ])(
    "$name, отказ сохраняет SQLite, pending и принятый cursor",
    async ({ encode, code, diagnosticName }) => {
      await withGitFixture(
        async (fixture) => {
          fixture.phase("prepare/accepted-baseline-and-pending");
          const writer = await fixture.replica("writer");
          const knowledge = new KnowledgeService(writer.db);
          const document = await knowledge.create(
            "document",
            { name: "Сохранить", body: "исходный" },
            "Автор",
          );
          await writer.engine.run();
          const reader = await fixture.replica("reader", writer);
          await reader.engine.run();
          await new KnowledgeService(reader.db).create(
            "document",
            { name: "Локальный pending", body: "не терять" },
            "Автор",
          );
          const before = reader.replication.capture();
          const beforeStatus = reader.replication.status();
          const accepted = await reader.repository.acceptedCommit();
          fixture.phase("prepare/corrupted-remote");
          await knowledge.update(
            "document",
            document.id,
            { body: "законное изменение" },
            { actor: "Автор", ifRevision: document.revision },
          );
          const candidate = writer.replication.prepare(
            writer.replication.acceptedSnapshot(),
          ).snapshot;
          const files = encode(candidate);
          const markdown = [...files.keys()].find(
            (path) => path.startsWith("entities/") && path.endsWith("/body.md"),
          );
          if (!markdown) {
            throw new Error("В fixture отсутствует Markdown документа");
          }
          files.set(markdown, Buffer.from("непроверенная подмена"));
          const corruptHead = await writer.repository.commit(
            files,
            await writer.repository.ref("refs/heads/data"),
          );
          requireGit(await writer.repository.push(corruptHead), "publish-corrupt-fixture");

          fixture.phase("act/reject-corrupted-snapshot");
          await expect(reader.engine.run()).rejects.toMatchObject({ code });

          fixture.phase("assert/unchanged-sqlite-outbox-and-cursor");
          expect(reader.replication.capture()).toEqual(before);
          expect(reader.replication.status()).toEqual(beforeStatus);
          expect(reader.db.get(document.id)?.data.body).toBe("исходный");
          expect(await reader.repository.acceptedCommit()).toBe(accepted);
          expect(await writer.repository.fetch()).toBe(corruptHead);
        },
        artifactGroup,
        { name: diagnosticName, deadlineMs },
      );
    },
    deadlineMs + GIT_FIXTURE_DRAIN_MS,
  );
});
