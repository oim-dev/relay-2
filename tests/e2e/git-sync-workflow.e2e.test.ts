import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { createGitSyncFixture } from "./helpers/git-sync-fixture";
import { invokeRecord, invokeSuccess, readRecordResult } from "./helpers/workflow-fixture";
import type { RecordResult } from "./helpers/workflow-fixture.types";

const branch = "relay-data-v2";
const bodyA = "# Запись A\n\n  Значимые пробелы\n\n```sh\necho '$HOME'\n```\n";
const bodyB = "# Запись B\n\nТочный текст: ё, λ, 🚀.\n\nСтрока с двумя пробелами.  \n";
const mergedBody = "# Общий документ\n\nТело независимо изменено участником B.\n";

/**
 * Извлекает единственную созданную карточку пакета, который также изменяет известный документ.
 */
function createdBatchRecord(value: unknown, existingId: string): RecordResult {
  if (
    value === null ||
    typeof value !== "object" ||
    !("entities" in value) ||
    !Array.isArray(value.entities)
  ) {
    throw new Error("Полный результат пакета должен содержать entities");
  }
  const created = value.entities.map(readRecordResult).filter((record) => record.id !== existingId);
  expect(created).toHaveLength(1);
  const record = created[0];
  if (record === undefined) {
    throw new Error("Пакет не вернул созданный документ");
  }
  return record;
}

/**
 * Декодирует полные успешные карточки группового чтения; частичный отказ не скрывается.
 */
function selectedRecords(value: unknown): RecordResult[] {
  if (
    value === null ||
    typeof value !== "object" ||
    !("items" in value) ||
    !Array.isArray(value.items)
  ) {
    throw new Error("Групповое чтение должно содержать items");
  }
  return value.items.map((item: unknown) => {
    if (
      item === null ||
      typeof item !== "object" ||
      !("ok" in item) ||
      item.ok !== true ||
      !("entity" in item)
    ) {
      throw new Error("Каждый запрошенный документ должен быть доступен после обмена");
    }
    return readRecordResult(item.entity);
  });
}

describe("Git-обмен через поставляемые бинарники", () => {
  test("restore и конкурентный обмен сохраняют обе записи с одинаковым ключом, ID-ссылки и независимые поля пакетов", async () => {
    const fixture = await createGitSyncFixture();
    const { a, b, remote } = fixture;
    try {
      await invokeSuccess(a, a.cwd, ["init", "--name", "Общая память", "--slug", "shared"]);
      const project = await invokeRecord(a, a.cwd, ["project", "get"]);
      const common = await invokeRecord(a, a.cwd, [
        "document",
        "create",
        "--name",
        "Общий документ",
        "--body",
        "Общее основание.\n",
        "--actor",
        "participant-a",
      ]);
      fixture.ownWorker(a);
      await invokeSuccess(a, a.cwd, [
        "git-sync",
        "connect",
        "--remote",
        remote,
        "--branch",
        branch,
      ]);
      await invokeSuccess(a, a.cwd, ["git-sync", "now"]);
      expect(await readdir(b.cwd)).toEqual([]);
      fixture.ownWorker(b);
      await invokeSuccess(b, b.cwd, [
        "git-sync",
        "restore",
        "--remote",
        remote,
        "--branch",
        branch,
      ]);
      const restoredProject = await invokeRecord(b, b.cwd, ["project", "get"]);
      expect(restoredProject.id).toBe(project.id);
      const commonA = await invokeRecord(a, a.cwd, ["document", "get", common.id]);
      const commonB = await invokeRecord(b, b.cwd, ["document", "get", common.id]);
      expect(commonB.data.body).toBe("Общее основание.\n");

      const [documentA, documentB] = await Promise.all([
        invokeRecord(a, a.cwd, [
          "document",
          "create",
          "--name",
          "Точечная запись A",
          "--body",
          bodyA,
          "--actor",
          "participant-a",
        ]),
        invokeRecord(b, b.cwd, [
          "document",
          "create",
          "--name",
          "Точечная запись B",
          "--body",
          bodyB,
          "--actor",
          "participant-b",
        ]),
      ]);
      expect(documentA.id).not.toBe(documentB.id);
      expect(documentA.key).toBe(documentB.key);
      const requestA = {
        version: 1,
        operations: [
          {
            op: "document.create",
            input: { name: "Ссылка A", body: "Ссылается на запись A.\n", targets: [documentA.key] },
          },
          {
            op: "document.update",
            ref: common.id,
            ifRevision: commonA.revision,
            input: { summary: "Описание участника A" },
          },
        ],
      };
      const requestB = {
        version: 1,
        operations: [
          {
            op: "document.create",
            input: { name: "Ссылка B", body: "Ссылается на запись B.\n", targets: [documentB.key] },
          },
          {
            op: "document.update",
            ref: common.id,
            ifRevision: commonB.revision,
            input: { body: mergedBody },
          },
        ],
      };
      const [batchA, batchB] = await Promise.all([
        invokeSuccess(a, a.cwd, [
          "batch",
          "--input",
          JSON.stringify(requestA),
          "--operation-key",
          "sync-a",
          "--actor",
          "participant-a",
          "--return",
          "full",
        ]),
        invokeSuccess(b, b.cwd, [
          "batch",
          "--input",
          JSON.stringify(requestB),
          "--operation-key",
          "sync-b",
          "--actor",
          "participant-b",
          "--return",
          "full",
        ]),
      ]);
      const linkA = createdBatchRecord(batchA, common.id);
      const linkB = createdBatchRecord(batchB, common.id);

      await Promise.all([
        invokeSuccess(a, a.cwd, ["git-sync", "now"]),
        invokeSuccess(b, b.cwd, ["git-sync", "now"]),
      ]);
      // Второй обмен принимает публикацию соседа, завершившуюся после собственного fetch.
      await Promise.all([
        invokeSuccess(a, a.cwd, ["git-sync", "now"]),
        invokeSuccess(b, b.cwd, ["git-sync", "now"]),
      ]);

      const ids = [documentA.id, documentB.id, linkA.id, linkB.id, common.id];
      const recordsA = selectedRecords(await invokeSuccess(a, a.cwd, ["get", ...ids]));
      const recordsB = selectedRecords(await invokeSuccess(b, b.cwd, ["get", ...ids]));
      for (const records of [recordsA, recordsB]) {
        expect(records).toHaveLength(5);
        expect(records).toMatchObject([
          { id: documentA.id, data: { name: "Точечная запись A", body: bodyA } },
          { id: documentB.id, data: { name: "Точечная запись B", body: bodyB } },
          {
            id: linkA.id,
            data: {
              body: "Ссылается на запись A.\n",
              relations: [{ target: { kind: "document", id: documentA.id }, type: "documents" }],
            },
          },
          {
            id: linkB.id,
            data: {
              body: "Ссылается на запись B.\n",
              relations: [{ target: { kind: "document", id: documentB.id }, type: "documents" }],
            },
          },
          {
            id: common.id,
            data: { name: "Общий документ", body: mergedBody, summary: "Описание участника A" },
          },
        ]);
        expect(new Set(records.map((record) => record.key)).size).toBe(records.length);
      }
      expect(recordsA.map(({ id, key, data }) => ({ id, key, data }))).toEqual(
        recordsB.map(({ id, key, data }) => ({ id, key, data })),
      );
      expect(await invokeSuccess(a, a.cwd, ["git-sync", "conflicts", "list"])).toEqual({
        conflicts: [],
        blocked: [],
      });
      expect(await invokeSuccess(b, b.cwd, ["git-sync", "conflicts", "list"])).toEqual({
        conflicts: [],
        blocked: [],
      });
    } finally {
      await fixture.close();
    }
  }, 60_000);
});
