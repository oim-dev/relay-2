import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createGitSyncFixture } from "./helpers/git-sync-fixture";
import type { GitSyncReplica } from "./helpers/git-sync-fixture.types";
import { readSingleGitSyncStatus } from "./helpers/git-sync-status";
import {
  invokeFailure,
  invokeRecord,
  invokeSuccess,
  workflowArtifactsDirectory,
} from "./helpers/workflow-fixture";
import type { ProcessResult } from "./helpers/workflow-fixture.types";

const baseBody = "# Основание\n\nИсходное общее правило.\n";
const remoteBody = "# Решение A\n\n  Удалённая редакция с отступом.\n";
const localBody = "# Решение B\n\nЛокальная редакция: `$HOME` буквально.  \n";

/**
 * Проверяет объектную форму внешнего материала конфликта без утверждения типа его полей.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Читает непустое поле адресации конфликта из внешнего JSON без утверждения типа.
 */
function conflictField(value: unknown, field: "id" | "fingerprint"): string {
  if (!isObject(value) || !(field in value)) {
    throw new Error(`Конфликт должен содержать ${field}`);
  }
  const content = value[field];
  if (typeof content !== "string" || content.length === 0) {
    throw new Error(`Поле ${field} конфликта должно быть непустой строкой`);
  }
  return content;
}

/**
 * Находит точное тело выбранного документа по ID в переносимых материалах конфликта.
 * local/remote могут включать backing project и другой read context; локальный CAS не требуется.
 */
function conflictDocumentBody(
  conflict: unknown,
  side: "before" | "after" | "local" | "remote",
  documentId: string,
): string {
  if (!isObject(conflict)) {
    throw new Error("Ожидался объект материалов конфликта");
  }
  let material: unknown;
  if (side === "before" || side === "after") {
    const changeset = conflict.changeset;
    if (!isObject(changeset) || !Array.isArray(changeset.entities)) {
      throw new Error("Конфликт должен содержать изменения entities");
    }
    const change: unknown = changeset.entities.find(
      (entry: unknown) => isObject(entry) && entry.id === documentId,
    );
    if (!isObject(change)) {
      throw new Error(`В changeset отсутствует изменение документа ${documentId}`);
    }
    material = change[side];
  } else {
    const records = conflict[side];
    if (!Array.isArray(records)) {
      throw new Error(`Сторона ${side} должна содержать массив переносимых записей`);
    }
    material = records.find(
      (entry: unknown) =>
        isObject(entry) && isObject(entry.record) && entry.record.id === documentId,
    );
  }
  if (
    !isObject(material) ||
    !isObject(material.record) ||
    material.record.id !== documentId ||
    material.record.kind !== "document" ||
    !isObject(material.record.data) ||
    typeof material.record.data.body !== "string"
  ) {
    throw new Error(`Сторона ${side} не содержит полного тела документа ${documentId}`);
  }
  return material.record.data.body;
}

/**
 * Сохраняет код и полные сырые потоки до assert, дополнительно форматируя валидные JSON-потоки.
 * Невалидный JSON остаётся в исходном result.json и не подменяется успешным ответом.
 */
async function saveCommandResult(
  directory: string,
  name: string,
  result: ProcessResult,
): Promise<void> {
  await writeFile(join(directory, `${name}.result.json`), JSON.stringify(result, null, 2) + "\n");
  for (const stream of ["stdout", "stderr"] as const) {
    let value: unknown;
    try {
      value = JSON.parse(result[stream]);
    } catch {
      continue;
    }
    await writeFile(
      join(directory, `${name}.${stream}.json`),
      JSON.stringify(value, null, 2) + "\n",
    );
  }
}

/**
 * Снимает только read-only диагностику одной копии после отказа доставки решения.
 * Отказ отдельного чтения сохраняется отдельно и не мешает проверке остальных материалов.
 */
async function saveReplicaResolutionState(
  replica: GitSyncReplica,
  name: string,
  directory: string,
  documentId: string,
  conflictId: string,
): Promise<void> {
  const commands = [
    { name: "status", args: ["git-sync", "status"] },
    { name: "conflicts-list", args: ["git-sync", "conflicts", "list"] },
    { name: "conflict", args: ["git-sync", "conflicts", "get", conflictId] },
    { name: "document", args: ["document", "get", documentId] },
  ];
  for (const command of commands) {
    const label = `${name}-${command.name}`;
    try {
      const result = await replica.invoke(replica.cwd, [...command.args, "--format", "json"]);
      await saveCommandResult(directory, label, result);
    } catch (error) {
      await writeFile(join(directory, `${label}.capture-error.txt`), String(error) + "\n");
    }
  }
}

describe("Разрешение реального Git-конфликта через CLI", () => {
  test("конкурентные тела доступны целиком и явное решение сохраняется после нового обмена", async () => {
    const fixture = await createGitSyncFixture();
    const { a, b, remote } = fixture;
    try {
      await invokeSuccess(a, a.cwd, ["init", "--name", "Конфликт текста", "--slug", "conflict"]);
      const initial = await invokeRecord(a, a.cwd, [
        "document",
        "create",
        "--name",
        "Правило",
        "--body",
        baseBody,
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
        "relay-data-v2",
      ]);
      await invokeSuccess(a, a.cwd, ["git-sync", "now"]);
      fixture.ownWorker(b);
      await invokeSuccess(b, b.cwd, [
        "git-sync",
        "restore",
        "--remote",
        remote,
        "--branch",
        "relay-data-v2",
      ]);
      const published = await invokeRecord(a, a.cwd, ["document", "get", initial.id]);
      const restored = await invokeRecord(b, b.cwd, ["document", "get", initial.id]);
      await Promise.all([
        invokeRecord(a, a.cwd, [
          "document",
          "update",
          initial.id,
          "--body",
          remoteBody,
          "--if-revision",
          String(published.revision),
          "--actor",
          "participant-a",
        ]),
        invokeRecord(b, b.cwd, [
          "document",
          "update",
          initial.id,
          "--body",
          localBody,
          "--if-revision",
          String(restored.revision),
          "--actor",
          "participant-b",
        ]),
      ]);

      await invokeSuccess(a, a.cwd, ["git-sync", "now"]);
      const conflictCode = await invokeFailure(b, b.cwd, ["git-sync", "now"], 4);

      expect(conflictCode).toBe("SYNC_CONFLICT");

      const status = readSingleGitSyncStatus(await invokeSuccess(b, b.cwd, ["git-sync", "status"]));
      expect(status).toMatchObject({ conflicts: { count: 1 } });
      const diagnostics = await invokeSuccess(b, b.cwd, ["git-sync", "conflicts", "list"]);
      if (!isObject(diagnostics) || !Array.isArray(diagnostics.conflicts)) {
        throw new Error("Диагностика должна содержать массив conflicts");
      }
      expect(diagnostics.blocked).toEqual([]);
      const conflicts = diagnostics.conflicts;
      expect(conflicts).toHaveLength(1);
      const conflictId = conflictField(conflicts[0], "id");
      const conflict = await invokeSuccess(b, b.cwd, ["git-sync", "conflicts", "get", conflictId]);
      expect(conflictField(conflict, "id")).toBe(conflictId);
      expect(conflictDocumentBody(conflict, "before", initial.id)).toBe(baseBody);
      expect(conflictDocumentBody(conflict, "after", initial.id)).toBe(localBody);
      expect(conflictDocumentBody(conflict, "local", initial.id)).toBe(localBody);
      expect(conflictDocumentBody(conflict, "remote", initial.id)).toBe(remoteBody);
      const preserved = await invokeRecord(b, b.cwd, ["document", "get", initial.id]);
      expect(preserved.data.body).toBe(localBody);
      await writeFile(
        join(b.cwd, "решение.json"),
        JSON.stringify({
          fingerprint: conflictField(conflict, "fingerprint"),
          choice: "local",
        }),
      );

      const resolution = await invokeSuccess(b, b.cwd, [
        "git-sync",
        "conflicts",
        "resolve",
        conflictId,
        "--input",
        "@решение.json",
        "--actor",
        "resolver",
      ]);
      const observedReplica = {
        ...b,
        /**
         * Сохраняет отказ now и обе стороны до проверки invokeSuccess и до finally cleanup.
         * Выполнение команды не повторяется; диагностические команды только читают состояние.
         */
        async invoke(cwd: string, argv: readonly string[], stdin?: string): Promise<ProcessResult> {
          const result = await b.invoke(cwd, argv, stdin);
          if (result.code !== 0 || result.stderr !== "") {
            const directory = join(
              workflowArtifactsDirectory,
              "git-sync-implementation/e2e/resolve-debug",
              basename(fixture.root),
            );
            await mkdir(directory, { recursive: true });
            await saveCommandResult(directory, "delivery", result);
            await writeFile(
              join(directory, "resolution-context.json"),
              JSON.stringify(
                {
                  documentId: initial.id,
                  conflictId,
                  decision: {
                    fingerprint: conflictField(conflict, "fingerprint"),
                    choice: "local",
                  },
                  viewedConflict: conflict,
                  preserved,
                  resolution,
                },
                null,
                2,
              ) + "\n",
            );
            await Promise.all([
              saveReplicaResolutionState(a, "a", directory, initial.id, conflictId),
              saveReplicaResolutionState(b, "b", directory, initial.id, conflictId),
            ]);
          }
          return result;
        },
      };
      await invokeSuccess(observedReplica, b.cwd, ["git-sync", "now"]);
      await invokeSuccess(a, a.cwd, ["git-sync", "now"]);

      for (const replica of [a, b]) {
        const read = await invokeRecord(replica, replica.cwd, ["document", "get", initial.id]);
        expect(read).toMatchObject({ id: initial.id, data: { name: "Правило", body: localBody } });
        expect(
          await invokeSuccess(replica, replica.cwd, ["git-sync", "conflicts", "list"]),
        ).toEqual({ conflicts: [], blocked: [] });
      }
    } finally {
      await fixture.close();
    }
  }, 60_000);
});
