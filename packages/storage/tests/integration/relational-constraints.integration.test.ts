import { describe, expect, test } from "bun:test";
import type { PlanStage, WorkPlanRecord } from "@relay/contracts";
import type { ProjectDatabase } from "../../src/database/project-database";
import {
  createDocument,
  createTask,
  ProjectDatabaseFixture,
} from "./helpers/project-database-fixture";

/**
 * Формирует полный план с явно заданными scoped ID этапов, без записи и вызова Core.
 * Данные проекта принадлежат fixture; сохраняет запись сам тест.
 */
function createPlan(
  database: ProjectDatabase,
  key: string,
  stages: readonly PlanStage[],
): WorkPlanRecord {
  return {
    ...createDocument(key),
    kind: "work-plan",
    data: {
      projectId: database.projectId,
      title: key,
      summary: "",
      goal: "",
      rationale: "",
      boundaries: "",
      expectedResult: "",
      result: "",
      status: "draft",
      startedAt: null,
      closedAt: null,
      scope: [],
      participants: [],
      stages: [...stages],
    },
  };
}

describe("Предметные внешние ключи физической SQLite-схемы", () => {
  test("существующий UUID чужого вида отклоняется matching-kind FK с откатом всей записи", () => {
    const fixture = new ProjectDatabaseFixture("matching-kind-fk", "database-redesign/test-review");
    try {
      const db = fixture.create();
      const owner = createDocument("DOC-1");
      const target = createDocument("DOC-2");
      db.insert(owner);
      db.insert(target);
      const before = db.list("document");
      const parts = db.getComponents([owner.id, target.id]);
      const generation = db.getGeneration();
      const outbox = db.getReplicationOutbox();

      fixture.withRaw((raw) => {
        raw.exec("PRAGMA foreign_keys=ON");
        let inserted = false;
        /**
         * Пишет напрямую в таблицы, обходя Core и codec. Обе сущности существуют,
         * но документ намеренно назван фичей; отказ ожидается от отложенного SQL FK.
         */
        const write = raw.transaction(() => {
          raw.query("UPDATE documents SET summary=? WHERE id=?").run("Не сохранять", owner.id);
          raw
            .query("UPDATE local_entity_revisions SET revision=revision+1 WHERE entity_id=?")
            .run(owner.id);
          raw.exec("UPDATE project_state SET generation=generation+1 WHERE singleton=1");
          raw
            .query(
              `INSERT INTO document_relations
                (owner_id,id,position,version,parents_json,deleted,
                 target_id,target_kind,relation_type,description,description_json)
               VALUES (?,?,'V',?,'[]',0,?,'feature','documents','',NULL)`,
            )
            .run(owner.id, "wrong-kind", "a".repeat(64), target.id);
          inserted = true;
        });

        expect(() => write.immediate()).toThrow(
          expect.objectContaining({ code: "SQLITE_CONSTRAINT_FOREIGNKEY" }),
        );

        expect(inserted).toBe(true);
        expect(raw.inTransaction).toBe(false);
        expect(
          raw.query("SELECT id FROM document_relations WHERE owner_id=?").all(owner.id),
        ).toEqual([]);
        expect(raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
      });

      expect(db.list("document")).toEqual(before);
      expect(db.getComponents([owner.id, target.id])).toEqual(parts);
      expect(db.getGeneration()).toBe(generation);
      expect(db.getReplicationOutbox()).toEqual(outbox);
    } finally {
      fixture.close();
    }
  });

  test("ID этапа другого владельца не удовлетворяет scoped FK и откатывает изменение плана", () => {
    const fixture = new ProjectDatabaseFixture("scoped-fk", "database-redesign/test-review");
    try {
      const db = fixture.create();
      const owner = createPlan(db, "PLN-1", []);
      const foreignStage: PlanStage = {
        id: "foreign-stage",
        title: "Этап другого плана",
        summary: "",
        outcome: "",
        completionConditions: "",
        taskIds: [],
      };
      const other = createPlan(db, "PLN-2", [foreignStage]);
      const task = createTask(db);
      db.insert(owner);
      db.insert(other);
      db.insert(task);
      const before = db.list("work-plan");
      const parts = db.getComponents([owner.id, other.id]);
      const generation = db.getGeneration();
      const outbox = db.getReplicationOutbox();

      fixture.withRaw((raw) => {
        raw.exec("PRAGMA foreign_keys=ON");
        expect(
          raw.query("SELECT owner_id,id FROM plan_stages WHERE id=?").all(foreignStage.id),
        ).toEqual([{ owner_id: other.id, id: foreignStage.id }]);
        let inserted = false;
        /**
         * UUID плана и задачи существуют, stageId тоже существует — только у другого
         * владельца. Предшествующие изменения должны откатиться при SQL COMMIT.
         */
        const write = raw.transaction(() => {
          raw.query("UPDATE work_plans SET summary=? WHERE id=?").run("Не сохранять", owner.id);
          raw
            .query("UPDATE local_entity_revisions SET revision=revision+1 WHERE entity_id=?")
            .run(owner.id);
          raw.exec("UPDATE project_state SET generation=generation+1 WHERE singleton=1");
          raw
            .query(
              `INSERT INTO plan_tasks
                (owner_id,id,position,version,parents_json,deleted,stage_id,task_id)
               VALUES (?,?,'V',?,'[]',0,?,?)`,
            )
            .run(owner.id, "wrong-stage-owner", "a".repeat(64), foreignStage.id, task.id);
          inserted = true;
        });

        expect(() => write.immediate()).toThrow(
          expect.objectContaining({ code: "SQLITE_CONSTRAINT_FOREIGNKEY" }),
        );

        expect(inserted).toBe(true);
        expect(raw.inTransaction).toBe(false);
        expect(raw.query("SELECT id FROM plan_tasks WHERE owner_id=?").all(owner.id)).toEqual([]);
        expect(raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
      });

      expect(db.list("work-plan")).toEqual(before);
      expect(db.getComponents([owner.id, other.id])).toEqual(parts);
      expect(db.get(task.id)).toEqual(task);
      expect(db.getGeneration()).toBe(generation);
      expect(db.getReplicationOutbox()).toEqual(outbox);
    } finally {
      fixture.close();
    }
  });
});
