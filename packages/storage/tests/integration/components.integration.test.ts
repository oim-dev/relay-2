import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { componentAllocatedId, type EntityRecord } from "@relay/contracts";
import { ProjectDatabase } from "../../src/database/project-database";
import {
  versionComponent,
  readComponents,
  flushComponentVersions,
} from "../../src/components/component-store";
import { insertEntity } from "../../src/entities/entity-writes";
import { applyComponentImportDelta } from "../../src/components/component-store";
import { planReplicationImport } from "../../src/replication/replication-import-plan";
import {
  componentCriterion,
  componentTask,
  withComponentsFixture,
} from "./helpers/components-fixture";
import type { ComponentReadInstruction } from "./helpers/components-fixture.types";

describe("Первичные нормализованные части SQLite", () => {
  test("sparse component import сохраняет точные версии, не сканирует owners и no-op не пишет part", () => {
    withComponentsFixture(({ db, raw }) => {
      const task = componentTask("task", "T-1", [componentCriterion("criterion")]);
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
            queries.mock.calls.some(([sql]) => /SELECT .*FROM entity_components/i.test(sql)),
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
      const task = componentTask("task", "T-1", [componentCriterion("criterion")]);
      const unrelated = componentTask("other", "T-2", [componentCriterion("other-criterion")]);
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
          queries.mock.calls.some(
            ([sql]) =>
              sql.includes("SELECT c.*,EXISTS") && sql.includes("FROM entity_components c"),
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
    withComponentsFixture(({ raw }) => {
      const allocationId = JSON.stringify(["preallocated-transition", 0]);
      const relation = {
        target: { kind: "task", id: "target" },
        type: "documents",
        description: "Связь",
      };
      const entity: EntityRecord = {
        ...componentTask("exact-owner", "DOC-EXACT", []),
        kind: "document",
        data: { name: "Exact", body: "Точный текст", relations: [relation] },
      };
      raw.exec("BEGIN IMMEDIATE");
      insertEntity(raw, entity, { allocationId });
      flushComponentVersions(raw);
      const first = readComponents(raw, [entity.id]);
      raw.exec("ROLLBACK; BEGIN IMMEDIATE");

      try {
        insertEntity(raw, entity, { allocationId });
        flushComponentVersions(raw);
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
        state: "paused",
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
        ...componentTask("session", "SESSION", []),
        kind: "work-session",
        data: { title: "Работа", status: "paused", runs: [run] },
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
        ...componentTask("document", "DOC-1", []),
        kind: "document",
        data: { name: "Документ", body: "Текст", relations: [] },
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
      const first = componentTask("one", "T-1", [componentCriterion("shared")]);
      const second = componentTask("two", "T-2", [componentCriterion("shared", "Другой владелец")]);
      db.insert(first);
      db.insert(second);

      const card = db.get(first.id);

      expect(card).toEqual({ ...first, data: { ...first.data, comments: [] } });
      const stored = raw
        .query<{ data: string }, [string]>("SELECT data FROM entities WHERE id=?")
        .get(first.id);
      expect(JSON.parse(stored?.data ?? "{}")).not.toHaveProperty("acceptanceCriteria");
      expect(JSON.parse(stored?.data ?? "{}")).not.toHaveProperty("dependencies");
      const parts = db
        .getComponents([first.id, second.id])
        .filter((part) => part.kind === "task-criterion");
      expect(parts.map((part) => [part.ownerId, part.id])).toEqual([
        ["one", "shared"],
        ["two", "shared"],
      ]);
      expect(parts[0]?.version).not.toBe(parts[1]?.version);
      expect(raw.query("SELECT type FROM sqlite_schema WHERE name='entity_refs'").get()).toEqual({
        type: "view",
      });
    });
  });

  test("правка одной части сохраняет версии соседей, а вставка не меняет их позиции", () => {
    withComponentsFixture(({ db }) => {
      const a = componentCriterion("a");
      const c = componentCriterion("c");
      const task = componentTask("task", "T-1", [a, c]);
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
      };
      const document: EntityRecord = {
        ...componentTask("doc", "DOC-1", []),
        kind: "document",
        data: { name: "Документ", body: "Точно\r\n", relations: [relation] },
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
      const plan: EntityRecord = {
        ...componentTask("plan", "PLN-1", []),
        kind: "work-plan",
        data: {
          title: "План",
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
        },
      };
      db.insert(plan);

      const parts = db.getComponents([plan.id]);

      expect(parts.find((part) => part.kind === "plan-stage")?.value).not.toHaveProperty("taskIds");
      expect(parts.find((part) => part.kind === "plan-task")?.value).toEqual({
        stageId: "stage",
        taskId: "task",
      });
      expect(
        raw.query<{ data: string }, [string]>("SELECT data FROM entities WHERE id=?").get(plan.id)
          ?.data,
      ).not.toContain("stages");
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

  test("malformed owner/part не проецируется в пустой массив", () => {
    withComponentsFixture(({ db, raw }) => {
      const task = componentTask("task", "T-1", [componentCriterion("criterion")]);
      db.insert(task);
      db.update({ ...task, revision: 2, data: { ...task.data, acceptanceCriteria: null } }, 1);
      expect(db.get(task.id)?.data.acceptanceCriteria).toBeNull();
      expect(db.listTaskGraph()[0]?.data.acceptanceCriteria).toBeNull();
      db.update({ ...task, revision: 3 }, 2);
      raw
        .query("UPDATE entity_components SET value=? WHERE owner_id=? AND kind='task-criterion'")
        .run('{"id":"criterion","completed":"bad"}', task.id);

      expect(() => db.get(task.id)).toThrow(expect.objectContaining({ code: "CORRUPT_DATA" }));
    });
  });

  test("повреждённая версия первичной части не исправляется обычным readonly get", () => {
    withComponentsFixture(({ db, raw }) => {
      const task = componentTask("task", "T-1", [componentCriterion("criterion")]);
      db.insert(task);
      raw
        .query("UPDATE entity_components SET version=? WHERE owner_id=? AND kind='task-criterion'")
        .run("0".repeat(64), task.id);

      expect(() => db.get(task.id)).toThrow(expect.objectContaining({ code: "CORRUPT_DATA" }));

      expect(
        raw
          .query<{ version: string }, [string]>(
            "SELECT version FROM entity_components WHERE owner_id=? AND kind='task-criterion'",
          )
          .get(task.id)?.version,
      ).toBe("0".repeat(64));
    });
  });

  test("окно гидратирует только выбранные parts одним пакетом, граф не декодирует тела критериев", () => {
    withComponentsFixture(({ db }) => {
      for (let index = 0; index < 5; index++) {
        db.insert(
          componentTask(`task-${index}`, `T-${index}`, [
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
      const dependency = componentTask("dependency", "T-0", []);
      const task = componentTask("task", "T-1", [componentCriterion("criterion")]);
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
      const table = raw
        .query<{ rootpage: number }, []>(
          "SELECT rootpage FROM sqlite_schema WHERE type='table' AND name='entity_components'",
        )
        .get();

      // Наличие индекса в схеме не гарантирует его выбор SQLite. Проверяем фактический bytecode:
      // открытый DeferredSeek допустим, но Column не должен читать primary component table.
      const instructions = raw.query<ComponentReadInstruction, []>(`EXPLAIN ${sql}`).all();
      const payloadCursors = new Set(
        instructions
          .filter((entry) => entry.opcode === "OpenRead" && entry.p2 === table?.rootpage)
          .map((entry) => entry.p1),
      );

      expect(table).not.toBeNull();
      expect(
        instructions.filter((entry) => entry.opcode === "Column" && payloadCursors.has(entry.p1)),
      ).toEqual([]);
    });
  });

  test("отказ outer transaction возвращает owner, части, их версии и outbox", () => {
    withComponentsFixture(({ db }) => {
      const task = componentTask("task", "T-1", [componentCriterion("one")]);
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
      db.insert(componentTask("task", "T-1", [componentCriterion("criterion")]));
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
