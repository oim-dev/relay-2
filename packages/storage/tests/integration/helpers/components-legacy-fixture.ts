import { Database } from "bun:sqlite";
import type { EntityRecord } from "@relay/contracts";
import { canonicalJson, replicationFingerprint } from "../../../src/replication/portable-version";
import { componentsLegacyV2, componentsLegacyV3 } from "./components-legacy-schema";
import { componentCriterion, componentTask } from "./components-fixture";

/**
 * Создаёт заполненную реальную v2/v3 по замороженной SQL-схеме, возвращает точные прежние DTO.
 * Соединение подготовки закрывается до open мигратора; путь/каталог принадлежат вызывающему fixture.
 */
export function createLegacyComponents(path: string, version: 2 | 3): readonly EntityRecord[] {
  const task = componentTask("legacy-task", "T-1", [componentCriterion("same", "Критерий A")]);
  task.data.boardId = "legacy-board";
  const metadata = {
    revision: 1,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    createdBy: task.createdBy,
    updatedBy: task.updatedBy,
  };
  const records: EntityRecord[] = [
    {
      ...metadata,
      id: "legacy-project",
      kind: "project",
      key: "PROJECT",
      data: {
        name: "Исторический",
        slug: "legacy",
        documentSections: [{ id: "section", name: "Решения" }],
        retiredDocumentSectionIds: ["retired"],
      },
    },
    { ...metadata, id: "legacy-product", kind: "product", key: "PRODUCT", data: {} },
    {
      ...metadata,
      id: "legacy-board",
      kind: "board",
      key: "BOARD-PRODUCT",
      data: { name: "Продукт", slug: "product", prefix: "PRODUCT" },
    },
    task,
    {
      ...componentTask("legacy-second", "T-2", [componentCriterion("same", "Критерий B")]),
      data: {
        ...task.data,
        title: "Другая",
        acceptanceCriteria: [componentCriterion("same", "Критерий B")],
      },
    },
    {
      ...metadata,
      id: "legacy-plan",
      kind: "work-plan",
      key: "PLN-1",
      data: {
        projectId: "legacy-project",
        title: "План",
        summary: "",
        goal: "Цель",
        rationale: "",
        boundaries: "",
        expectedResult: "",
        participants: ["Участник"],
        scope: [],
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
            taskIds: [task.id],
          },
        ],
      },
    },
    {
      ...metadata,
      id: "legacy-document",
      kind: "document",
      key: "DOC-7",
      data: {
        name: "Документ",
        summary: "",
        body: "\r\n# Точно\tё e\u0301  \r\nбез последнего LF",
        documentKind: "specification",
        documentStatus: "draft",
        sectionId: "section",
        pinned: false,
        relations: [
          {
            target: { kind: "task", id: task.id },
            type: "documents",
            description: "Исходная связь",
          },
        ],
      },
    },
    {
      ...metadata,
      id: "legacy-session",
      kind: "work-session",
      key: "SESSION",
      data: {
        title: "Работа",
        description: null,
        status: "open",
        currentRunId: "run",
        parentSessionId: null,
        originCheckpointId: null,
        createdByRunId: null,
        result: null,
        closedAt: null,
        runs: [
          {
            id: "run",
            key: "RUN-run",
            actor: "original",
            state: "active",
            reason: null,
            operator: null,
            client: null,
            sourceSessionId: null,
            predecessorRunId: null,
            startedAt: task.createdAt,
            endedAt: null,
            endReason: null,
          },
        ],
      },
    },
  ];
  const raw = new Database(path, { create: true, strict: true });
  try {
    raw.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; BEGIN IMMEDIATE;");
    raw.exec(version === 2 ? componentsLegacyV2 : componentsLegacyV3);
    raw.exec(
      `PRAGMA application_id=0x524c5932; PRAGMA user_version=${version}; INSERT INTO project_state VALUES(1,'legacy-project',0);`,
    );
    const insert = raw.query("INSERT INTO entities VALUES(?,?,?,?,?,?,?,?,?)");
    for (const record of records) {
      insert.run(
        record.id,
        record.kind,
        record.key,
        record.revision,
        record.createdAt,
        record.updatedAt,
        record.createdBy,
        record.updatedBy,
        JSON.stringify(record.data),
      );
    }
    raw.exec(
      "INSERT INTO entity_refs VALUES('DOC-OLD','legacy-document'); INSERT INTO key_counters VALUES('DOC',17);",
    );
    raw
      .query(
        "INSERT INTO task_comments(id,task_id,title,body,created_at,created_by) VALUES(?,?,?,?,?,?)",
      )
      .run("legacy-comment", task.id, "", "Журнал\r\nточно", task.createdAt, "reviewer");
    raw
      .query("INSERT INTO batch_receipts VALUES(?,?,?)")
      .run(
        "legacy-receipt",
        '{ "actor": "original", "historical": true }',
        '{ "entities": [{"key":"DOC-OLD","revision":17}], "immutable": true }',
      );
    raw.exec("UPDATE project_state SET generation=83 WHERE singleton=1");
    if (version === 3) {
      for (const record of records) {
        const { revision: _revision, ...versioned } = record;
        raw
          .query("INSERT INTO replication_entity_versions VALUES(?,?,?)")
          .run(record.id, replicationFingerprint({ ...versioned, parents: [] }), "[]");
      }
      raw.exec(
        "INSERT INTO replication_comment_order VALUES('legacy-comment',NULL); DELETE FROM replication_address_queue;",
      );
      const { revision: _taskRevision, ...versionedTask } = task;
      const payload = {
        formatVersion: 1,
        projectId: "legacy-project",
        mode: "mutation",
        id: "legacy-replica:7",
        replicaId: "legacy-replica",
        sequence: 7,
        createdAt: task.createdAt,
        dependencies: [],
        readContext: [],
        entities: [
          {
            id: task.id,
            before: null,
            after: {
              record: task,
              version: replicationFingerprint({ ...versionedTask, parents: [] }),
              parents: [],
            },
          },
        ],
        addresses: [],
        comments: [],
        receipts: [],
      };
      const source = canonicalJson({ ...payload, digest: replicationFingerprint(payload) });
      raw
        .query("INSERT INTO replication_outbox VALUES(?,?,?)")
        .run(payload.id, payload.sequence, source);
      raw
        .query("INSERT INTO replication_owner_heads VALUES(?,?)")
        .run(`entity:${task.id}`, payload.id);
    }
    raw.exec("COMMIT");
  } finally {
    if (raw.inTransaction) {
      raw.exec("ROLLBACK");
    }
    raw.close();
  }
  return records;
}
