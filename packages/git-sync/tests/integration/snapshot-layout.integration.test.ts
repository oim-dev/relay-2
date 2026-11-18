import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { BatchService, KnowledgeService, TasksService } from "@relay/core";
import { decodeSnapshot, encodeSnapshot } from "../../src/snapshot/codec";
import { SyncEngine } from "../../src/sync/engine";
import { git, requireGit } from "../../src/transport/git";
import type { GitFiles } from "../../src/transport/repository.types";
import { observeExchangeDatabase } from "./helpers/crash-exchange-state";
import { GIT_FIXTURE_DRAIN_MS, withGitFixture } from "./helpers/git-fixture";
import { gitFixtureDeadlines } from "./helpers/git-fixture-budgets";
import { encodeLegacyLayoutFixture } from "./helpers/layout-1-fixture";

const artifactGroup = "database-redesign/git-layout-fixtures";
const body = "\ufeff# Точный текст ё, e\u0301 и 🙂\r\n\tБез конечного LF  ";
const summary = "Непарные UTF-16: \ud800/\udfff; CRLF\r\n";
const commentBody = "\ufeffКомментарий e\u0301\r\n\t🙂  ";
const deadlineMs = gitFixtureDeadlines.exchange;
const legacyLayouts = [
  { name: "layout 1", version: 1 },
  { name: "layout 2", version: 2 },
] as const;

/**
 * Читает JSON-объект непосредственно из Git bytes, не вызывая проверяемый декодер snapshot.
 * Отсутствующий файл и другой вид JSON завершают fixture ошибкой.
 */
function readJsonObject(files: GitFiles, path: string): Record<string, unknown> {
  const bytes = files.get(path);
  if (bytes === undefined) {
    throw new Error(`В публикации отсутствует ${path}`);
  }
  const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`В ${path} ожидался JSON-объект`);
  }
  return value as Record<string, unknown>;
}

/**
 * Сверяет папки с реальными SQL-таблицами, а JSON документа — с его переносимыми колонками.
 * Ожидание читается отдельным readonly-соединением, без mapper/encoder Storage; соединение закрывается.
 */
function expectTableFilesMatchSql(files: GitFiles, databasePath: string, documentId: string): void {
  const sql = new Database(databasePath, { readonly: true });
  try {
    const tables = sql
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => row.name);
    const rows = [...files.keys()].filter((path) => path.includes("/"));
    expect(rows.some((path) => path.startsWith("document_relations/"))).toBe(true);
    expect(rows.some((path) => path.startsWith("task_comments/"))).toBe(true);
    expect(rows.some((path) => path.startsWith("batch_receipts/"))).toBe(true);
    expect(rows.some((path) => path.startsWith("replication_confirmations/"))).toBe(true);
    expect(rows.some((path) => path.startsWith("replication_publications/"))).toBe(true);
    for (const path of rows) {
      expect(path).toMatch(/^[a-z][a-z0-9_]*\/[a-f0-9]{64}\.json$/);
      expect(tables).toContain(path.slice(0, path.indexOf("/")));
      const row = readJsonObject(files, path);
      expect(row).not.toHaveProperty("data");
      expect(row).not.toHaveProperty("value");
      expect(row).not.toHaveProperty("markdown");
    }
    expect([...files.keys()].every((path) => path.endsWith(".json"))).toBe(true);
    expect([...files.keys()].filter((path) => !path.includes("/"))).toEqual(["manifest.json"]);
    expect(rows.some((path) => /^(entities|components|comments|receipts)\//.test(path))).toBe(
      false,
    );

    const documentPath = `documents/${createHash("sha256")
      .update(JSON.stringify([documentId]))
      .digest("hex")}.json`;
    const documentRow = sql
      .query<Record<string, unknown>, [string]>(
        `SELECT id, created_at, updated_at, created_by, updated_by, project_id,
          name, name_json, summary, summary_json, body, body_json,
          document_kind, document_status, section_id, pinned
        FROM documents WHERE id=?`,
      )
      .get(documentId);
    if (documentRow === null) {
      throw new Error("Созданный документ должен присутствовать в физической таблице");
    }
    expect(readJsonObject(files, documentPath)).toEqual(documentRow);
    expect(documentRow).toMatchObject({
      body,
      body_json: null,
      summary: null,
      summary_json: JSON.stringify(summary),
    });
  } finally {
    sql.close();
  }
}

describe("Табличный Git layout 3", () => {
  test(
    "Git переносит точные SQL-строки, версии, source и receipt в другую SQLite без echo",
    async () => {
      await withGitFixture(
        async (fixture) => {
          fixture.phase("prepare/accepted-baseline");
          const writer = await fixture.replica("table-writer");
          const task = await new TasksService(writer.db).create(
            { title: "Цель документа" },
            "Автор",
          );
          await writer.engine.run();
          const baseline = writer.replication.acceptedSnapshot();
          const baselineHead = await writer.repository.acceptedCommit();
          if (!baseline?.publication || !baselineHead) {
            throw new Error("Не принята начальная публикация fixture");
          }
          const reader = await fixture.replica("table-reader", writer);
          await reader.engine.run();
          requireGit(
            await git(writer.repository.options.directory, ["config", "core.autocrlf", "true"], {
              env: writer.repository.options.env ?? {},
              signal: fixture.signal,
            }),
            "fixture-autocrlf",
          );
          const operationKey = "table-layout-exact-text";
          const result = await new BatchService(writer.db).execute(
            {
              version: 1,
              operations: [
                {
                  op: "document.create",
                  input: {
                    name: "Документ e\u0301 🙂",
                    body,
                    summary,
                    relations: [
                      {
                        target: { kind: "task", id: task.id },
                        type: "documents",
                        description: body,
                      },
                    ],
                  },
                },
                { op: "task.comment.add", ref: task.id, input: { body: commentBody } },
              ],
            },
            { actor: "Автор", operationKey },
          );
          const documentId = result.items[0]?.id;
          const [source] = writer.db.getReplicationOutbox();
          const original = writer.replication.capture();
          const originalDocument = original.entities.find((item) => item.record.id === documentId);
          const receipt = writer.db.getBatchReceipt(operationKey);
          if (!documentId || !source || !originalDocument || !receipt) {
            throw new Error("Не сохранён пакет документа, комментария и квитанции");
          }
          expect(writer.db.getReplicationOutbox()).toEqual([source]);

          fixture.phase("act/publish-table-rows");
          await writer.engine.run();
          const head = await writer.repository.acceptedCommit();
          if (!head) {
            throw new Error("Отсутствует принятая Git-публикация");
          }
          const files = await writer.repository.files(head);
          const published = decodeSnapshot(files);

          fixture.phase("assert/sql-rows-and-portable-proofs");
          expect(readJsonObject(files, "manifest.json")).toEqual({
            layoutVersion: 3,
            formatVersion: 1,
            modelVersion: 2,
            projectId: writer.db.projectId,
          });
          expectTableFilesMatchSql(files, writer.db.path, documentId);
          expect(published.entities.find((item) => item.record.id === documentId)).toEqual(
            originalDocument,
          );
          expect(published.components?.filter((part) => part.ownerId === documentId)).toEqual(
            original.components?.filter((part) => part.ownerId === documentId),
          );
          expect(published.comments).toEqual(original.comments);
          expect(published.publication?.changes.map((change) => change.source)).toEqual([source]);
          expect(published.publication?.parent).toEqual({
            publicationId: baseline.publication.publicationId,
            snapshotDigest: baseline.publication.snapshotDigest,
          });
          expect(published.receipts).toEqual([receipt]);

          fixture.phase("act/read-into-another-sqlite");
          await reader.engine.run();

          expect(reader.db.path).not.toBe(writer.db.path);
          expect(reader.replication.capture()).toEqual(writer.replication.capture());
          expect(reader.db.get(documentId)?.data).toMatchObject({ body, summary });
          expect(new TasksService(reader.db).comments(task.id)).toMatchObject([
            { body: commentBody },
          ]);
          expect(new BatchService(reader.db).getResult(operationKey)).toEqual({
            ...result,
            replayed: true,
          });
          const beforeWriter = observeExchangeDatabase(writer.db, writer.replication);
          const beforeReader = observeExchangeDatabase(reader.db, reader.replication);

          fixture.phase("act/reopen-and-repeat-exchange");
          await new SyncEngine(
            reader.directory,
            reader.db.projectId,
            reader.replication,
            reader.repository,
            fixture.signal,
          ).run();
          await writer.engine.run();
          await reader.engine.run();

          fixture.phase("assert/no-echo");
          expect(observeExchangeDatabase(writer.db, writer.replication)).toEqual(beforeWriter);
          expect(observeExchangeDatabase(reader.db, reader.replication)).toEqual(beforeReader);
          expect(writer.db.getReplicationOutbox()).toEqual([]);
          expect(reader.db.getReplicationOutbox()).toEqual([]);
          expect(await writer.repository.ref("refs/heads/data")).toBe(head);
          expect(await reader.repository.ref("refs/heads/data")).toBe(head);
          expect(await writer.repository.history(head, null)).toEqual([
            { head: baselineHead, parent: null },
            { head, parent: baselineHead },
          ]);
        },
        artifactGroup,
        { name: "layout-three-roundtrip", deadlineMs },
      );
    },
    deadlineMs + GIT_FIXTURE_DRAIN_MS,
  );

  test.each(legacyLayouts)(
    "$name явно отклоняется с сохранением SQLite, outbox и принятого cursor",
    async ({ version }) => {
      await withGitFixture(
        async (fixture) => {
          fixture.phase("prepare/accepted-baseline-and-pending");
          const writer = await fixture.replica("legacy-writer");
          const knowledge = new KnowledgeService(writer.db);
          const document = await knowledge.create(
            "document",
            { name: "Сохранить", body: "исходный" },
            "Автор",
          );
          await writer.engine.run();
          const reader = await fixture.replica("legacy-reader", writer);
          await reader.engine.run();
          await new KnowledgeService(reader.db).create(
            "document",
            { name: "Локальный pending", body: "не терять" },
            "Автор",
          );
          const before = observeExchangeDatabase(reader.db, reader.replication);
          const beforeStatus = reader.replication.status();
          const accepted = await reader.repository.acceptedCommit();
          expect(before.outbox).toHaveLength(1);
          expect(accepted).not.toBeNull();
          await knowledge.update(
            "document",
            document.id,
            { body: "изменение в несовместимом layout" },
            { actor: "Автор", ifRevision: document.revision },
          );
          const candidate = writer.replication.prepare(
            writer.replication.acceptedSnapshot(),
          ).snapshot;
          const legacyHead = await writer.repository.commit(
            encodeLegacyLayoutFixture(candidate, version),
            await writer.repository.acceptedCommit(),
          );
          requireGit(await writer.repository.push(legacyHead), "publish-legacy-fixture");

          fixture.phase("act/reject-legacy-layout");
          await expect(reader.engine.run()).rejects.toMatchObject({
            code: "GIT_FORMAT_INCOMPATIBLE",
          });

          fixture.phase("assert/unchanged-sqlite-outbox-and-cursor");
          expect(observeExchangeDatabase(reader.db, reader.replication)).toEqual(before);
          expect(reader.replication.status()).toEqual(beforeStatus);
          expect(reader.db.get(document.id)?.data.body).toBe("исходный");
          expect(await reader.repository.acceptedCommit()).toBe(accepted);
          expect(await writer.repository.fetch()).toBe(legacyHead);
        },
        artifactGroup,
        { name: `layout-${version}-rejected`, deadlineMs },
      );
    },
    deadlineMs + GIT_FIXTURE_DRAIN_MS,
  );

  test(
    "подмена предметной строки без новой версии и proof отклоняется до применения",
    async () => {
      await withGitFixture(
        async (fixture) => {
          fixture.phase("prepare/accepted-baseline-and-pending");
          const writer = await fixture.replica("corrupt-writer");
          const knowledge = new KnowledgeService(writer.db);
          const document = await knowledge.create(
            "document",
            { name: "Сохранить", body: "исходный" },
            "Автор",
          );
          await writer.engine.run();
          const reader = await fixture.replica("corrupt-reader", writer);
          await reader.engine.run();
          await new KnowledgeService(reader.db).create(
            "document",
            { name: "Локальный pending", body: "не терять" },
            "Автор",
          );
          const before = observeExchangeDatabase(reader.db, reader.replication);
          const beforeStatus = reader.replication.status();
          const accepted = await reader.repository.acceptedCommit();
          expect(before.outbox).toHaveLength(1);
          expect(accepted).not.toBeNull();
          await knowledge.update(
            "document",
            document.id,
            { body: "законное изменение" },
            { actor: "Автор", ifRevision: document.revision },
          );
          const candidate = writer.replication.prepare(
            writer.replication.acceptedSnapshot(),
          ).snapshot;
          const files = encodeSnapshot(candidate);
          const documentPath = [...files.keys()].find((path) => path.startsWith("documents/"));
          if (!documentPath) {
            throw new Error("В fixture отсутствует строка таблицы documents");
          }
          // Меняем только содержимое реальной строки; версия, source digest и publication остаются прежними.
          const corruptedRow = {
            ...readJsonObject(files, documentPath),
            body: "непроверенная подмена",
          };
          files.set(documentPath, Buffer.from(JSON.stringify(corruptedRow)));
          const corruptHead = await writer.repository.commit(
            files,
            await writer.repository.acceptedCommit(),
          );
          requireGit(await writer.repository.push(corruptHead), "publish-corrupt-fixture");

          fixture.phase("act/reject-corrupted-row");
          await expect(reader.engine.run()).rejects.toMatchObject({ code: "REPLICATION_FORMAT" });

          fixture.phase("assert/unchanged-sqlite-outbox-and-cursor");
          expect(observeExchangeDatabase(reader.db, reader.replication)).toEqual(before);
          expect(reader.replication.status()).toEqual(beforeStatus);
          expect(reader.db.get(document.id)?.data.body).toBe("исходный");
          expect(await reader.repository.acceptedCommit()).toBe(accepted);
          expect(await writer.repository.fetch()).toBe(corruptHead);
        },
        artifactGroup,
        { name: "layout-three-corrupted-row", deadlineMs },
      );
    },
    deadlineMs + GIT_FIXTURE_DRAIN_MS,
  );
});
