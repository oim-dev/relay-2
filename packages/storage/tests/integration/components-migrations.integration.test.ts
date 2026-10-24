import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { componentMigrationId } from "@relay/contracts";
import { ProjectDatabase } from "../../src/database/project-database";
import { createLegacyComponents } from "./helpers/components-legacy-fixture";
import { withComponentsFixture } from "./helpers/components-fixture";

const corruptedVersionCases = [
  {
    name: "hash не соответствует исходной карточке",
    sql: `UPDATE replication_entity_versions SET version='${"0".repeat(64)}' WHERE entity_id='legacy-task'`,
  },
  {
    name: "у существующего owner отсутствует версия",
    sql: "DELETE FROM replication_entity_versions WHERE entity_id='legacy-task'",
  },
  {
    name: "parents не являются каноническим набором версий",
    sql: "UPDATE replication_entity_versions SET parents_json='{}' WHERE entity_id='legacy-task'",
  },
] as const;

describe("Сохраняющие переходы к нормализованной v4", () => {
  test.each(corruptedVersionCases)(
    "v3 отклоняет повреждение до normalization: $name",
    ({ sql }) => {
      withComponentsFixture(({ directory }) => {
        const path = join(directory, "corrupted-version.sqlite");
        createLegacyComponents(path, 3);
        const raw = new Database(path, { strict: true });
        try {
          // Намеренно повреждаем сохранённое основание, которое нельзя легализовать новым hash.
          raw.exec(sql);
          const structure = raw.query("SELECT name,sql FROM sqlite_schema ORDER BY name").all();
          const records = raw.query("SELECT * FROM entities ORDER BY id").all();
          const versions = raw
            .query("SELECT * FROM replication_entity_versions ORDER BY entity_id")
            .all();
          const outbox = raw.query("SELECT * FROM replication_outbox ORDER BY sequence").all();

          expect(() => {
            const unexpected = ProjectDatabase.open(path);
            unexpected.close();
          }).toThrow(
            expect.objectContaining({
              code: "CORRUPT_DATA",
              details: expect.objectContaining({ id: "legacy-task" }),
            }),
          );

          expect(raw.query("PRAGMA user_version").get()).toEqual({ user_version: 3 });
          expect(raw.query("SELECT name,sql FROM sqlite_schema ORDER BY name").all()).toEqual(
            structure,
          );
          expect(raw.query("SELECT * FROM entities ORDER BY id").all()).toEqual(records);
          expect(
            raw.query("SELECT * FROM replication_entity_versions ORDER BY entity_id").all(),
          ).toEqual(versions);
          expect(raw.query("SELECT * FROM replication_outbox ORDER BY sequence").all()).toEqual(
            outbox,
          );
        } finally {
          raw.close();
        }
      });
    },
  );

  test.each([2, 3] as const)(
    "v%d сохраняет карточки, scoped IDs, aliases, комментарии, квитанции и исходный outbox",
    (version) => {
      withComponentsFixture(({ directory }) => {
        const path = join(directory, `legacy-${version}.sqlite`);
        const records = createLegacyComponents(path, version);
        const raw = new Database(path, { strict: true });
        const beforeReceipts = raw.query("SELECT * FROM batch_receipts").all();
        const beforeComments = raw
          .query("SELECT sequence,id,task_id,title,body,created_at,created_by FROM task_comments")
          .all();
        const beforeOutbox =
          version === 3 ? raw.query("SELECT * FROM replication_outbox").all() : [];
        const migrated = ProjectDatabase.open(path);
        try {
          expect(raw.query("PRAGMA user_version").get()).toEqual({ user_version: 4 });
          expect(migrated.getGeneration()).toBe(83);
          for (const record of records) {
            const actual = migrated.get(record.id);
            if (record.kind === "task") {
              expect(actual).toMatchObject({ ...record, data: record.data });
            } else {
              expect(actual).toEqual(record);
            }
          }
          expect(migrated.get("DOC-OLD")?.id).toBe("legacy-document");
          expect(raw.query("SELECT * FROM batch_receipts").all()).toEqual(beforeReceipts);
          expect(
            raw
              .query(
                "SELECT sequence,id,task_id,title,body,created_at,created_by FROM task_comments",
              )
              .all(),
          ).toEqual(beforeComments);
          expect(raw.query("SELECT * FROM key_counters").all()).toEqual([
            { prefix: "DOC", value: 17 },
          ]);
          const parts = migrated.getComponents();
          expect(
            parts
              .filter((part) => part.kind === "task-criterion")
              .map((part) => [part.ownerId, part.id]),
          ).toEqual([
            ["legacy-second", "same"],
            ["legacy-task", "same"],
          ]);
          const membership = parts.find((part) => part.kind === "plan-task");
          expect(membership?.id).toBe(
            componentMigrationId(
              "legacy-plan",
              "plan-task",
              JSON.stringify(["stage", "legacy-task"]),
            ),
          );
          expect(parts.find((part) => part.kind === "document-relation")?.parents).toEqual([]);
          if (version === 3) {
            expect(raw.query("SELECT * FROM replication_outbox").all()).toEqual(beforeOutbox);
          } else {
            expect(migrated.getReplicationOutbox()).toHaveLength(1);
            expect(migrated.getReplicationOutbox()[0]?.components?.length).toBe(parts.length);
          }
          const outbox = raw.query("SELECT * FROM replication_outbox").all();
          migrated.close();
          const reopened = ProjectDatabase.open(path);
          try {
            expect(reopened.getComponents()).toEqual(parts);
            expect(raw.query("SELECT * FROM replication_outbox").all()).toEqual(outbox);
            expect(reopened.getGeneration()).toBe(83);
          } finally {
            reopened.close();
          }
        } finally {
          migrated.close();
          raw.close();
        }
      });
    },
  );
});
