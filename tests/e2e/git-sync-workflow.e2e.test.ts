import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { createGitSyncFixture } from "./helpers/git-sync-fixture";
import type { GitSyncFixture } from "./helpers/git-sync-fixture.types";
import {
  invokeFailure,
  invokeRecord,
  invokeSuccess,
  readRecordResult,
} from "../../apps/cli/tests/e2e/helpers/workflow-fixture";
import type { RecordResult } from "../../apps/cli/tests/e2e/helpers/workflow-fixture.types";

const branch = "relay-data";
const bodyA = "# Запись A\n\n  Значимые пробелы\n\n```sh\necho '$HOME'\n```\n";
const bodyB = "# Запись B\n\nТочный текст: ё, λ, 🚀.\n\nСтрока с двумя пробелами.  \n";
const mergedBody = "# Общий документ\n\nТело независимо изменено участником B.\n";

/**
 * Проверяет объектную форму внешнего JSON без утверждения типов его полей.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Читает фактический HEAD только из bare remote fixture с изолированным Git-окружением.
 * Ограниченный локальный процесс не выполняет сеть и не изменяет репозиторий.
 */
function publishedHead(fixture: GitSyncFixture): string {
  return execFileSync(
    "git",
    ["--git-dir", fixture.remote, "rev-parse", "--verify", `refs/heads/${branch}`],
    {
      cwd: fixture.a.cwd,
      env: fixture.a.variables,
      encoding: "utf8",
      timeout: 10_000,
    },
  ).trim();
}

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
  test("restore и явный выбор ключей сохраняют ID-ссылки, точные тексты и независимые поля пакетов", async () => {
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
      await invokeSuccess(a, a.cwd, [
        "git-sync",
        "connect",
        "--remote",
        remote,
        "--branch",
        branch,
      ]);
      await invokeSuccess(a, a.cwd, ["git-sync", "now"]);
      await invokeSuccess(a, a.cwd, ["git-sync", "auto", "disable"]);
      expect(await readdir(b.cwd)).toEqual([]);
      await invokeSuccess(b, b.cwd, [
        "git-sync",
        "restore",
        "--remote",
        remote,
        "--branch",
        branch,
      ]);
      const restoredProject = await invokeRecord(b, b.cwd, ["project", "get"]);
      await invokeSuccess(b, b.cwd, ["git-sync", "auto", "disable"]);
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
      expect(linkA.key).toBe(linkB.key);
      if (!isObject(batchA) || !isObject(batchB)) {
        throw new Error("Исходные квитанции пакетов должны быть объектами");
      }

      // Публикация A закрепляет оба исходных назначения; B обязан дождаться явного выбора.
      await invokeSuccess(a, a.cwd, ["git-sync", "now"]);
      const conflictCode = await invokeFailure(b, b.cwd, ["git-sync", "now"], 4);
      expect(conflictCode).toBe("SYNC_CONFLICT");
      for (const expected of [
        { entity: documentB, owner: documentA, key: "DOC-42" },
        { entity: linkB, owner: linkA, key: "DOC-43" },
      ]) {
        // Пакет со ссылкой зависит от первого создания: его коллизия открывается после решения.
        const conflicts = await invokeSuccess(b, b.cwd, ["git-sync", "keys", "list"]);
        if (!Array.isArray(conflicts)) {
          throw new Error("Список коллизий ключей должен быть массивом");
        }
        expect(conflicts).toHaveLength(1);
        const conflict: unknown = conflicts[0];
        if (
          !isObject(conflict) ||
          typeof conflict.id !== "string" ||
          typeof conflict.fingerprint !== "string" ||
          !Array.isArray(conflict.collisions)
        ) {
          throw new Error("Коллизия должна содержать ID, fingerprint и столкнувшиеся назначения");
        }
        expect(conflict.fingerprint).toMatch(/^[a-f0-9]{64}$/);
        expect(conflict.code).toBe("REPLICATION_KEY_COLLISION");
        expect(conflict.collisions).toHaveLength(1);
        expect(conflict.collisions[0]).toMatchObject({
          entityId: expected.entity.id,
          key: expected.entity.key,
          acceptedOwnerId: expected.owner.id,
        });
        const collision: unknown = conflict.collisions[0];
        if (
          !isObject(collision) ||
          typeof collision.entityId !== "string" ||
          typeof collision.key !== "string"
        ) {
          throw new Error("Назначение должно содержать постоянный ID и исходный ключ");
        }
        const resolution = await invokeSuccess(b, b.cwd, [
          "git-sync",
          "keys",
          "resolve",
          conflict.id,
          "--input",
          JSON.stringify({
            fingerprint: conflict.fingerprint,
            assignments: [
              { entityId: collision.entityId, fromKey: collision.key, key: expected.key },
            ],
          }),
          "--actor",
          "participant-b",
        ]);
        expect(resolution).toMatchObject({
          id: conflict.id,
          included: expect.arrayContaining([conflict.id]),
        });
      }

      await invokeSuccess(b, b.cwd, ["git-sync", "now"]);
      await invokeSuccess(a, a.cwd, ["git-sync", "now"]);

      const ids = [documentA.id, documentB.id, linkA.id, linkB.id, common.id];
      const recordsA = selectedRecords(await invokeSuccess(a, a.cwd, ["get", ...ids]));
      const recordsB = selectedRecords(await invokeSuccess(b, b.cwd, ["get", ...ids]));
      for (const records of [recordsA, recordsB]) {
        expect(records).toHaveLength(5);
        expect(records).toMatchObject([
          {
            id: documentA.id,
            key: documentA.key,
            data: { name: "Точечная запись A", body: bodyA },
          },
          { id: documentB.id, key: "DOC-42", data: { name: "Точечная запись B", body: bodyB } },
          {
            id: linkA.id,
            key: linkA.key,
            data: {
              body: "Ссылается на запись A.\n",
              relations: [{ target: { kind: "document", id: documentA.id }, type: "documents" }],
            },
          },
          {
            id: linkB.id,
            key: "DOC-43",
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
      for (const replica of [a, b]) {
        expect(await invokeSuccess(replica, replica.cwd, ["git-sync", "keys", "list"])).toEqual([]);
        for (const { operationKey, original } of [
          { operationKey: "sync-a", original: batchA },
          { operationKey: "sync-b", original: batchB },
        ]) {
          const receipt = await invokeSuccess(replica, replica.cwd, [
            "batch",
            "result",
            operationKey,
            "--return",
            "full",
          ]);
          expect(receipt).toEqual({ ...original, replayed: true });
        }
      }
      const acceptedHead = publishedHead(fixture);

      await Promise.all([
        invokeSuccess(a, a.cwd, ["git-sync", "now"]),
        invokeSuccess(b, b.cwd, ["git-sync", "now"]),
      ]);

      expect(selectedRecords(await invokeSuccess(a, a.cwd, ["get", ...ids]))).toEqual(recordsA);
      expect(selectedRecords(await invokeSuccess(b, b.cwd, ["get", ...ids]))).toEqual(recordsB);
      expect(publishedHead(fixture)).toBe(acceptedHead);
    } finally {
      await fixture.close();
    }
  }, 60_000);
});
