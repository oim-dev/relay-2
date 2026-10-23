import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createWorkflowEnvironment,
  invokeRecord,
  invokeSuccess,
  readRecordResult,
} from "./helpers/workflow-fixture";
import type { RecordResult } from "./helpers/workflow-fixture.types";

/**
 * Извлекает полные карточки из внешнего JSON результата пакета после проверки контейнера.
 */
function batchRecords(value: unknown): RecordResult[] {
  if (
    value === null ||
    typeof value !== "object" ||
    !("entities" in value) ||
    !Array.isArray(value.entities)
  ) {
    throw new Error("Полный результат пакета должен содержать массив entities");
  }
  return value.entities.map(readRecordResult);
}

/**
 * Находит единственный результат по ожидаемому предметному названию, независимо от порядка квитанции.
 */
function namedRecord(records: readonly RecordResult[], name: string): RecordResult {
  const found = records.filter((record) => record.data.name === name || record.data.title === name);
  expect(found).toHaveLength(1);
  const record = found[0];
  if (record === undefined) {
    throw new Error(`В результате отсутствует запись «${name}»`);
  }
  return record;
}

describe("Связанная декомпозиция через поставляемый бинарник", () => {
  test("проверенный пакет публикует рабочий набор и восстанавливает исходную квитанцию между запусками", async () => {
    const env = await createWorkflowEnvironment();
    try {
      const cwd = join(env.root, "Пакетный проект");
      await mkdir(cwd);
      await invokeSuccess(env, cwd, ["init", "--name", "Переговорная", "--slug", "booking"]);
      const previous = await invokeRecord(env, cwd, [
        "document",
        "create",
        "--name",
        "Предыдущая редакция",
        "--body",
        "Исходное требование.",
        "--document-status",
        "active",
        "--actor",
        "human",
      ]);
      const body = "# Правила бронирования\n\n  Значимый отступ\n\n```text\n$HOME буквально\n```\n";
      const criterion = "Повторный запрос не создаёт второе бронирование";
      const request = {
        version: 1,
        operations: [
          { op: "feature.create", as: "booking", input: { name: "Бронирование" } },
          {
            op: "scenario.create",
            as: "retry",
            input: { name: "Повтор запроса", feature: { $ref: "booking" } },
          },
          {
            op: "task.create",
            as: "retry-task",
            input: {
              title: "Обеспечить повторяемость запроса",
              targets: [{ $ref: "retry" }],
              acceptanceCriteria: [{ title: criterion }],
            },
          },
          {
            op: "document.create",
            as: "new-spec",
            input: { name: "Правила бронирования", body, documentStatus: "active" },
          },
          {
            op: "document.update",
            ref: previous.key,
            ifRevision: previous.revision,
            input: { documentStatus: "archived" },
          },
        ],
      };
      const input = JSON.stringify(request);
      await writeFile(join(cwd, "подготовленный пакет.json"), input);

      const checked = await invokeSuccess(env, cwd, [
        "batch",
        "--input",
        "@подготовленный пакет.json",
        "--actor",
        "agent",
        "--check",
      ]);
      expect(checked).toMatchObject({ status: "checked" });
      const unchanged = await invokeRecord(env, cwd, ["document", "get", previous.key]);
      expect(unchanged).toEqual(previous);

      const applied = await invokeSuccess(
        env,
        cwd,
        [
          "batch",
          "--input",
          "-",
          "--actor",
          "agent",
          "--operation-key",
          "booking-01",
          "--return",
          "full",
        ],
        input,
      );
      expect(applied).toMatchObject({
        status: "committed",
        operationKey: "booking-01",
        replayed: false,
      });
      const records = batchRecords(applied);
      const feature = namedRecord(records, "Бронирование");
      const scenario = namedRecord(records, "Повтор запроса");
      const task = namedRecord(records, "Обеспечить повторяемость запроса");
      const document = namedRecord(records, "Правила бронирования");
      const archived = namedRecord(records, "Предыдущая редакция");
      expect(scenario.data.featureId).toBe(feature.id);
      expect(task.data.targets).toEqual([scenario.id]);
      expect(task.data.acceptanceCriteria).toMatchObject([{ title: criterion, completed: false }]);
      expect(document.data).toMatchObject({ body, documentStatus: "active" });
      expect(archived).toMatchObject({
        id: previous.id,
        revision: previous.revision + 1,
        data: { body: "Исходное требование.", documentStatus: "archived" },
      });

      const selected = [document, task, scenario];
      const read = await invokeSuccess(env, cwd, ["get", ...selected.map((record) => record.key)]);
      expect(read).toMatchObject({
        view: "full",
        items: selected.map((entity) => ({ ref: entity.key, ok: true, entity })),
      });
      const summary = await invokeSuccess(env, cwd, ["get", document.key, task.key, "--summary"]);
      expect(summary).toMatchObject({
        view: "summary",
        items: [
          {
            ref: document.key,
            ok: true,
            entity: { id: document.id, title: "Правила бронирования" },
          },
          {
            ref: task.key,
            ok: true,
            entity: { id: task.id, title: "Обеспечить повторяемость запроса" },
          },
        ],
      });
      expect(JSON.stringify(summary)).not.toContain("$HOME буквально");
      expect(JSON.stringify(summary)).not.toContain(criterion);

      const changed = await invokeRecord(env, cwd, [
        "document",
        "update",
        document.key,
        "--body",
        "Следующее уточнение после публикации пакета.",
        "--if-revision",
        String(document.revision),
        "--actor",
        "editor",
      ]);
      expect(changed.data.body).toBe("Следующее уточнение после публикации пакета.");

      const recovered = await invokeSuccess(env, cwd, [
        "batch",
        "result",
        "booking-01",
        "--return",
        "full",
      ]);
      expect(batchRecords(recovered)).toEqual(records);
      const replayed = await invokeSuccess(env, cwd, [
        "batch",
        "--input",
        input,
        "--actor",
        "agent",
        "--operation-key",
        "booking-01",
        "--return",
        "full",
      ]);
      expect(replayed).toMatchObject({ replayed: true, operationKey: "booking-01" });
      expect(batchRecords(replayed)).toEqual(records);
      const current = await invokeRecord(env, cwd, ["document", "get", document.key]);
      expect(current).toEqual(changed);
    } finally {
      await env.close();
    }
  });
});
