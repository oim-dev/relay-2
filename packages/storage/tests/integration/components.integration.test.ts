import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  componentAllocatedId,
  type EntityRecord,
  type HistorySessionData,
  type TaskCriterion,
  type WorkPlanData,
} from "@relay/contracts";
import { ProjectDatabase } from "../../src/database/project-database";
import { versionComponent, readComponents } from "../../src/components/component-store";
import { insertEntity } from "../../src/entities/entity-writes";
import { applyComponentImportDelta } from "../../src/components/component-store";
import { planReplicationImport } from "../../src/replication/replication-import-plan";
import { componentCriterion } from "./helpers/components-fixture";
import type {
  ComponentReadInstruction,
  ComponentsFixture,
} from "./helpers/components-fixture.types";
import {
  createDocument,
  createTask,
  ProjectDatabaseFixture,
} from "./helpers/project-database-fixture";

/**
 * Удерживает отдельную файловую базу и raw-соединение с действующими FK до конца сценария.
 * Каталог текущей даты и все соединения очищаются при любом исходе.
 */
function withComponentsFixture(run: (fixture: ComponentsFixture) => void): void {
  const fixture = new ProjectDatabaseFixture("components");
  try {
    const db = fixture.create();
    fixture.withRaw((raw) => {
      raw.exec("PRAGMA foreign_keys=ON");
      run({ db, raw, directory: fixture.directory });
    });
  } finally {
    fixture.close();
  }
}

/**
 * Формирует задачу существующей доски с заданными постоянным ID и scoped IDs критериев.
 * Подготовка не сохраняет запись; все связи сценария создаются явно в тесте.
 */
function componentTask(
  db: ProjectDatabase,
  id: string,
  key: string,
  criteria: readonly TaskCriterion[],
): EntityRecord {
  return {
    ...createTask(db, key, {
      title: id,
      description: `Описание ${id}`,
      acceptanceCriteria: [...criteria],
    }),
    id,
  };
}

describe("Первичные нормализованные части SQLite", () => {
  test("sparse component import сохраняет точные версии, не сканирует owners и no-op не пишет part", () => {
    withComponentsFixture(({ db, raw }) => {
      const task = componentTask(db, "task", "T-1", [componentCriterion("criterion")]);
      db.insert(task);
      const original = db.getComponents([task.id]).find((part) => part.kind === "task-criterion");
      if (original === undefined || original.kind !== "task-criterion") {
        throw new Error("Нет критерия");
      }
      const next = versionComponent({
        ...original,
        parents: [original.version],
        value: { ...original.value, title: "Импорт" },
      });
      if (next.kind !== "task-criterion") {
        throw new Error("Версионирование изменило вид части");
      }
      const outbox = db.getReplicationOutbox();
      raw.exec("BEGIN IMMEDIATE; UPDATE replication_state SET importing=1 WHERE singleton=1;");
      try {
        applyComponentImportDelta(raw, [next], []);
        const revision = raw
          .query<{ revision: number }, []>(
            "SELECT revision FROM command_read_state WHERE singleton=1",
          )
          .get()?.revision;
        const queries = spyOn(Database.prototype, "query");
        try {
          applyComponentImportDelta(raw, [next], []);
          expect(
            queries.mock.calls.some(
              ([sql]) =>
                /FROM\s+(entity_components|task_criteria)\b/i.test(sql) &&
                !/WHERE[\s\S]*owner_id\s*=\s*\?[\s\S]*\bid\s*=\s*\?/i.test(sql),
            ),
          ).toBe(false);
        } finally {
          queries.mockRestore();
        }
        expect(
          raw
            .query<{ revision: number }, []>(
              "SELECT revision FROM command_read_state WHERE singleton=1",
            )
            .get()?.revision,
        ).toBe(revision);
        raw.exec("UPDATE replication_state SET importing=0 WHERE singleton=1; COMMIT;");
      } finally {
        if (raw.inTransaction) {
          raw.exec("ROLLBACK");
        }
      }
      expect(db.getComponents([task.id]).find((part) => part.kind === "task-criterion")).toEqual(
        next,
      );
      expect(db.getReplicationOutbox()).toEqual(outbox);
    });
  });

  test("подготовленный parts-only план увеличивает только CAS затронутого owner без полного capture под lock", () => {
    withComponentsFixture(({ db }) => {
      const task = componentTask(db, "task", "T-1", [componentCriterion("criterion")]);
      const unrelated = componentTask(db, "other", "T-2", [componentCriterion("other-criterion")]);
      db.insert(task);
      db.insert(unrelated);
      const current = db.captureReplication();
      const part = current.components?.find(
        (entry) => entry.kind === "task-criterion" && entry.ownerId === task.id,
      );
      if (part === undefined || part.kind !== "task-criterion") {
        throw new Error("Нет критерия");
      }
      const changed = versionComponent({
        ...part,
        parents: [part.version],
        value: { ...part.value, title: "Удалённая правка" },
      });
      const candidate = {
        ...current,
        components: (current.components ?? []).map((entry) => (entry === part ? changed : entry)),
      };
      const plan = planReplicationImport(current, candidate);
      const outbox = db.getReplicationOutbox();
      expect(plan.entities.map((entry) => entry.id)).toEqual([task.id]);
      const queries = spyOn(Database.prototype, "query");
      try {
        db.importReplication(candidate, plan);
        expect(
          queries.mock.calls.some(([sql]) => sql.includes("FROM entity_refs ORDER BY ref")),
        ).toBe(false);
        expect(
          queries.mock.calls.some(([sql]) =>
            /FROM\s+entity_components(?:\s+c)?\s+ORDER\s+BY/i.test(sql),
          ),
        ).toBe(false);
      } finally {
        queries.mockRestore();
      }
      expect(db.get(task.id)?.revision).toBe(2);
      expect(db.get(unrelated.id)?.revision).toBe(1);
      expect(db.get(task.id)?.data.acceptanceCriteria).toEqual([
        { ...componentCriterion("criterion"), title: "Удалённая правка" },
      ]);
      expect(db.getReplicationOutbox()).toEqual(outbox);
    });
  });

  test("повтор exact effect после rollback сохраняет заранее зафиксированные IDs частей и адресов", () => {
    withComponentsFixture(({ db, raw }) => {
      const allocationId = JSON.stringify(["preallocated-transition", 0]);
      db.insert(componentTask(db, "target", "TARGET", []));
      const entity: EntityRecord = {
        ...createDocument("DOC-EXACT", {
          name: "Exact",
          body: "Точный текст",
          relations: [
            { target: { kind: "task", id: "target" }, type: "documents", description: "Связь" },
          ],
        }),
        id: "exact-owner",
      };
      raw.exec("BEGIN IMMEDIATE");
      insertEntity(raw, entity, { allocationId });
      const first = readComponents(raw, [entity.id]);
      raw.exec("ROLLBACK; BEGIN IMMEDIATE");

      try {
        insertEntity(raw, entity, { allocationId });
        const retried = readComponents(raw, [entity.id]);
        expect(retried).toEqual(first);
        expect(retried.find((part) => part.kind === "document-relation")?.id).toBe(
          componentAllocatedId(
            allocationId,
            entity.id,
            "document-relation",
            JSON.stringify(["target", "documents"]),
          ),
        );
        expect(
          retried.find(
            (part) => part.kind === "address-assignment" && part.value.ref === entity.key,
          )?.id,
        ).toBe(componentAllocatedId(allocationId, entity.id, "address-assignment", entity.key));
      } finally {
        raw.exec("ROLLBACK");
      }
    });
  });

  test("завершённое участие не переписывается, отказ возвращает owner/parts/outbox", () => {
    withComponentsFixture(({ db }) => {
      const run = {
        id: "run",
        key: "RUN-run",
        actor: "original",
        state: "paused" as const,
        reason: null,
        operator: null,
        client: null,
        sourceSessionId: null,
        predecessorRunId: null,
        startedAt: "2026-10-20T12:00:00.000Z",
        endedAt: "2026-10-21T12:00:00.000Z",
        endReason: "Пауза",
      };
      const session: EntityRecord = {
        ...createDocument("SESSION"),
        id: "session",
        kind: "work-session",
        createdAt: run.startedAt,
        updatedAt: run.endedAt,
        createdBy: run.actor,
        updatedBy: run.actor,
        data: {
          title: "Работа",
          description: null,
          status: "paused",
          currentRunId: null,
          parentSessionId: null,
          originCheckpointId: null,
          createdByRunId: null,
          result: null,
          closedAt: null,
          runs: [run],
        } satisfies HistorySessionData,
      };
      db.insert(session);
      const before = db.get(session.id);
      const parts = db.getComponents([session.id]);
      const queue = db.getReplicationOutbox();

      expect(() =>
        db.update(
          {
            ...session,
            revision: 2,
            data: { ...session.data, runs: [{ ...run, endReason: "Переписанная история" }] },
          },
          1,
        ),
      ).toThrow(expect.objectContaining({ code: "CONFLICT" }));

      expect(db.get(session.id)).toEqual(before);
      expect(db.getComponents([session.id])).toEqual(parts);
      expect(db.getReplicationOutbox()).toEqual(queue);
    });
  });

  test("обычный rename сохраняет первичное назначение старого алиаса с исходным ID/version", () => {
    withComponentsFixture(({ db }) => {
      const document: EntityRecord = {
        ...createDocument("DOC-1"),
        id: "document",
      };
      db.insert(document);
      const initial = db
        .getComponents([document.id])
        .find((part) => part.kind === "address-assignment" && part.value.ref === "DOC-1");

      db.rename(document.id, "DOC-2", 1, "editor");

      expect(db.get("DOC-1")?.id).toBe(document.id);
      expect(
        db
          .getComponents([document.id])
          .find((part) => part.kind === "address-assignment" && part.value.ref === "DOC-1"),
      ).toEqual(initial);
      expect(
        db
          .getComponents([document.id])
          .filter((part) => part.kind === "address-assignment" && !part.deleted),
      ).toHaveLength(3);
    });
  });

  test("owner не дублирует коллекции, а карточка собирается с прежними scoped IDs", () => {
    withComponentsFixture(({ db, raw }) => {
      const first = componentTask(db, "one", "T-1", [componentCriterion("shared")]);
      const second = componentTask(db, "two", "T-2", [
        componentCriterion("shared", "Другой владелец"),
      ]);
      db.insert(first);
      db.insert(second);

      const card = db.get(first.id);

      expect(card).toEqual({ ...first, data: { ...first.data, comments: [] } });
      const stored = raw.query("SELECT * FROM tasks WHERE id=?").get(first.id);
      expect(stored).toMatchObject({ id: first.id, title: "one", parent_task_id: null });
      expect(stored).not.toHaveProperty("data");
      expect(stored).not.toHaveProperty("acceptanceCriteria");
      expect(stored).not.toHaveProperty("dependencies");
      const parts = db
        .getComponents([first.id, second.id])
        .filter((part) => part.kind === "task-criterion");
      expect(parts.map((part) => [part.ownerId, part.id])).toEqual([
        ["one", "shared"],
        ["two", "shared"],
      ]);
      expect(parts[0]?.version).not.toBe(parts[1]?.version);
      expect(
        raw
          .query(
            "SELECT name,type FROM sqlite_schema WHERE name IN ('entities','entity_components','entity_refs') ORDER BY name",
          )
          .all(),
      ).toEqual([
        { name: "entities", type: "view" },
        { name: "entity_components", type: "view" },
        { name: "entity_refs", type: "view" },
      ]);
    });
  });

  test("правка одной части сохраняет версии соседей, а вставка не меняет их позиции", () => {
    withComponentsFixture(({ db }) => {
      const a = componentCriterion("a");
      const c = componentCriterion("c");
      const task = componentTask(db, "task", "T-1", [a, c]);
      db.insert(task);
      const before = db.getComponents([task.id]).filter((part) => part.kind === "task-criterion");

      db.update(
        {
          ...task,
          revision: 2,
          data: {
            ...task.data,
            acceptanceCriteria: [{ ...a, title: "Изменён" }, componentCriterion("b"), c],
          },
        },
        1,
      );

      const after = db.getComponents([task.id]).filter((part) => part.kind === "task-criterion");
      expect(after.find((part) => part.id === "a")?.version).not.toBe(
        before.find((part) => part.id === "a")?.version,
      );
      expect(after.find((part) => part.id === "c")).toEqual(before.find((part) => part.id === "c"));
      expect(after.find((part) => part.id === "a")?.position).toBe(
        before.find((part) => part.id === "a")?.position,
      );
      expect(db.get(task.id)?.data.acceptanceCriteria).toEqual([
        { ...a, title: "Изменён" },
        componentCriterion("b"),
        c,
      ]);
      const change = db.getReplicationOutbox().at(-1);
      expect(
        change?.components
          ?.filter((part) => part.after?.kind === "task-criterion")
          .map((part) => part.after?.id)
          .sort(),
      ).toEqual(["a", "b"]);
    });
  });

  test("remove/readd отношения выделяет новый ID и сохраняет tombstone с корректной версией", () => {
    withComponentsFixture(({ db }) => {
      const relation = {
        target: { kind: "task", id: "target" },
        type: "documents",
        description: "Связь",
      } as const;
      db.insert(componentTask(db, "target", "TARGET", []));
      const document: EntityRecord = {
        ...createDocument("DOC-1", { body: "Точно\r\n", relations: [relation] }),
        id: "doc",
      };
      db.insert(document);
      const original = db
        .getComponents([document.id])
        .find((part) => part.kind === "document-relation");
      if (original === undefined) {
        throw new Error("Нет отношения");
      }
      db.update({ ...document, revision: 2, data: { ...document.data, relations: [] } }, 1);

      db.update({ ...document, revision: 3 }, 2);

      const relations = db
        .getComponents([document.id])
        .filter((part) => part.kind === "document-relation");
      expect(relations).toHaveLength(2);
      const retired = relations.find((part) => part.id === original.id);
      expect(retired?.deleted).toBe(true);
      expect(retired?.parents).toEqual([original.version]);
      if (retired === undefined) {
        throw new Error("Нет tombstone");
      }
      expect(versionComponent(retired).version).toBe(retired.version);
      expect(relations.find((part) => !part.deleted)?.id).not.toBe(original.id);
      expect(db.get(document.id)?.data.relations).toEqual([relation]);
    });
  });

  test("план хранит этап и включение отдельно, пустой этап сохраняет taskIds:[]", () => {
    withComponentsFixture(({ db, raw }) => {
      db.insert(componentTask(db, "task", "T-1", []));
      const plan: EntityRecord = {
        ...createDocument("PLN-1"),
        id: "plan",
        kind: "work-plan",
        data: {
          projectId: db.projectId,
          title: "План",
          summary: "",
          goal: "",
          rationale: "",
          boundaries: "",
          expectedResult: "",
          result: "",
          status: "draft",
          startedAt: null,
          closedAt: null,
          stages: [
            {
              id: "stage",
              title: "Этап",
              summary: "",
              outcome: "",
              completionConditions: "",
              taskIds: ["task"],
            },
          ],
          scope: [],
          participants: [],
        } satisfies WorkPlanData,
      };
      db.insert(plan);

      const parts = db.getComponents([plan.id]);

      expect(parts.find((part) => part.kind === "plan-stage")?.value).not.toHaveProperty("taskIds");
      expect(parts.find((part) => part.kind === "plan-task")?.value).toEqual({
        stageId: "stage",
        taskId: "task",
      });
      const owner = raw.query("SELECT * FROM work_plans WHERE id=?").get(plan.id);
      expect(owner).toMatchObject({ id: plan.id, title: "План", project_id: db.projectId });
      expect(owner).not.toHaveProperty("data");
      expect(owner).not.toHaveProperty("stages");
      expect(
        raw.query("SELECT owner_id,id,title FROM plan_stages WHERE owner_id=?").all(plan.id),
      ).toEqual([{ owner_id: plan.id, id: "stage", title: "Этап" }]);
      expect(
        raw.query("SELECT owner_id,stage_id,task_id FROM plan_tasks WHERE owner_id=?").all(plan.id),
      ).toEqual([{ owner_id: plan.id, stage_id: "stage", task_id: "task" }]);
      const empty = {
        id: "stage",
        title: "Этап",
        summary: "",
        outcome: "",
        completionConditions: "",
        taskIds: [],
      };
      db.update({ ...plan, revision: 2, data: { ...plan.data, stages: [empty] } }, 1);
      expect(db.get(plan.id)?.data.stages).toEqual([empty]);
      expect(
        db.getComponents([plan.id]).filter((part) => part.kind === "plan-task" && part.deleted),
      ).toHaveLength(1);
    });
  });

  test("неверная коллекция и повреждение typed критерия отклоняются без потери owner/parts/outbox", () => {
    withComponentsFixture(({ db, raw }) => {
      const task = componentTask(db, "task", "T-1", [componentCriterion("criterion")]);
      db.insert(task);
      const parts = db.getComponents([task.id]);
      const generation = db.getGeneration();
      const outbox = db.getReplicationOutbox();

      expect(() =>
        db.update({ ...task, revision: 2, data: { ...task.data, acceptanceCriteria: null } }, 1),
      ).toThrow(expect.objectContaining({ code: "CORRUPT_DATA" }));
      expect(() =>
        raw.query("UPDATE task_criteria SET completed=2 WHERE owner_id=?").run(task.id),
      ).toThrow(expect.objectContaining({ code: "SQLITE_CONSTRAINT_CHECK" }));

      expect(db.get(task.id)).toEqual(task);
      expect(db.listTaskGraph()[0]?.data.acceptanceCriteria).toEqual([{ completed: false }]);
      expect(db.getComponents([task.id])).toEqual(parts);
      expect(db.getGeneration()).toBe(generation);
      expect(db.getReplicationOutbox()).toEqual(outbox);
    });
  });

  test("повреждённая версия первичной части не исправляется обычным readonly get", () => {
    withComponentsFixture(({ db, raw }) => {
      const task = componentTask(db, "task", "T-1", [componentCriterion("criterion")]);
      db.insert(task);
      raw.query("UPDATE task_criteria SET version=? WHERE owner_id=?").run("0".repeat(64), task.id);

      expect(() => db.get(task.id)).toThrow(expect.objectContaining({ code: "CORRUPT_DATA" }));

      expect(
        raw
          .query<{ version: string }, [string]>(
            "SELECT version FROM task_criteria WHERE owner_id=?",
          )
          .get(task.id)?.version,
      ).toBe("0".repeat(64));
    });
  });

  test("окно гидратирует только выбранные parts одним пакетом, граф не декодирует тела критериев", () => {
    withComponentsFixture(({ db }) => {
      for (let index = 0; index < 5; index++) {
        db.insert(
          componentTask(db, `task-${index}`, `T-${index}`, [
            { ...componentCriterion(`c-${index}`), description: `BODY-NOT-FOR-GRAPH-${index}` },
          ]),
        );
      }
      const decode = spyOn(JSON, "parse");
      const query = spyOn(Database.prototype, "query");
      try {
        const page = db.listPage("task", { offset: 2, limit: 1, sort: "key" });
        expect(page.total).toBe(5);
        expect(page.items.map((item) => item.id)).toEqual(["task-2"]);
        expect(
          decode.mock.calls.some(
            ([json]) =>
              json.includes("BODY-NOT-FOR-GRAPH-0") || json.includes("BODY-NOT-FOR-GRAPH-4"),
          ),
        ).toBe(false);
        expect(
          query.mock.calls.filter(
            ([sql]) =>
              sql.includes("SELECT * FROM entity_components") && sql.includes("owner_id IN"),
          ).length,
        ).toBe(1);
        decode.mockClear();
        const graph = db.listTaskGraph();
        expect(graph).toHaveLength(5);
        expect(graph[0]?.data.acceptanceCriteria).toEqual([{ completed: false }]);
        expect(decode.mock.calls.some(([json]) => json.includes("BODY-NOT-FOR-GRAPH"))).toBe(false);
      } finally {
        query.mockRestore();
        decode.mockRestore();
      }
    });
  });

  test("граф читает metadata частей из покрывающих индексов без обращения к payload-строкам", () => {
    withComponentsFixture(({ db, raw }) => {
      const dependency = componentTask(db, "dependency", "T-0", []);
      const task = componentTask(db, "task", "T-1", [componentCriterion("criterion")]);
      task.data.dependencies = [dependency.id];
      db.insert(dependency);
      db.insert(task);
      const query = spyOn(Database.prototype, "query");
      let sql: string | undefined;
      try {
        const graph = db.listTaskGraph();
        sql = query.mock.calls[0]?.[0];
        const selected = graph.find((record) => record.id === task.id);
        expect(selected?.data.acceptanceCriteria).toEqual([{ completed: false }]);
        expect(selected?.data.dependencies).toEqual([dependency.id]);
      } finally {
        query.mockRestore();
      }
      if (sql === undefined) {
        throw new Error("Граф не выполнил SQL-чтение");
      }
      const tables = raw
        .query<{ rootpage: number }, []>(
          "SELECT rootpage FROM sqlite_schema WHERE type='table' AND name IN ('task_criteria','task_dependencies')",
        )
        .all();
      const payloadRoots = new Set(tables.map((table) => table.rootpage));

      // Наличие индекса в схеме не гарантирует его выбор SQLite. Проверяем фактический bytecode:
      // открытый DeferredSeek допустим, но Column не должен читать primary component table.
      const instructions = raw.query<ComponentReadInstruction, []>(`EXPLAIN ${sql}`).all();
      const payloadCursors = new Set(
        instructions
          .filter((entry) => entry.opcode === "OpenRead" && payloadRoots.has(entry.p2))
          .map((entry) => entry.p1),
      );

      expect(tables).toHaveLength(2);
      expect(
        instructions.filter((entry) => entry.opcode === "Column" && payloadCursors.has(entry.p1)),
      ).toEqual([]);
    });
  });

  test("отказ outer transaction возвращает owner, части, их версии и outbox", () => {
    withComponentsFixture(({ db }) => {
      const task = componentTask(db, "task", "T-1", [componentCriterion("one")]);
      db.insert(task);
      const parts = db.getComponents([task.id]);
      const outbox = db.getReplicationOutbox();
      const generation = db.getGeneration();

      expect(() =>
        db.transaction(() => {
          db.update(
            {
              ...task,
              revision: 2,
              data: { ...task.data, acceptanceCriteria: [componentCriterion("two")] },
            },
            1,
          );
          throw new Error("rollback");
        }),
      ).toThrow("rollback");

      expect(db.getComponents([task.id])).toEqual(parts);
      expect(db.getReplicationOutbox()).toEqual(outbox);
      expect(db.getGeneration()).toBe(generation);
      expect(db.get(task.id)).toEqual({ ...task, data: { ...task.data, comments: [] } });
    });
  });

  test("restore сохраняет точные IDs/версии/позиции частей и не создаёт echo", () => {
    withComponentsFixture(({ db, directory }) => {
      db.insert(componentTask(db, "task", "T-1", [componentCriterion("criterion")]));
      const snapshot = db.captureReplication();
      const parts = db.getComponents();
      const restored = ProjectDatabase.createReplica(
        join(directory, "restored.sqlite"),
        db.projectId,
      );
      try {
        restored.bootstrapReplication(snapshot);
        expect(restored.getComponents()).toEqual(parts);
        expect(restored.get("task")).toEqual(db.get("task"));
        expect(restored.getReplicationOutbox()).toEqual([]);
      } finally {
        restored.close();
      }
    });
  });
});
