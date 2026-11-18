import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { ProjectDatabase } from "../../src/database/project-database";
import { createLegacyComponents } from "./helpers/components-legacy-fixture";
import { ProjectDatabaseFixture, expectRelayError } from "./helpers/project-database-fixture";

const legacySchemas = [
  { name: "v2 с вложенными коллекциями и исторической квитанцией", version: 2 },
  { name: "v3 с версиями владельцев и неизменяемым outbox", version: 3 },
] as const;
const corruptedVersionCases = [
  {
    name: "hash не соответствует исходной карточке",
    sql: `UPDATE replication_entity_versions SET version='${"0".repeat(64)}' WHERE entity_id='legacy-task'`,
  },
  {
    name: "у существующего владельца отсутствует версия",
    sql: "DELETE FROM replication_entity_versions WHERE entity_id='legacy-task'",
  },
  {
    name: "parents не являются каноническим набором версий",
    sql: "UPDATE replication_entity_versions SET parents_json='{}' WHERE entity_id='legacy-task'",
  },
] as const;

describe("Отказ открытия прежней схемы компонентов", () => {
  for (const method of ["open", "openReadonly"] as const) {
    test.each(legacySchemas)(
      `${method}: $name сохраняется побайтно без нормализации и включения WAL`,
      ({ version }) => {
        const fixture = new ProjectDatabaseFixture("legacy-components", "database-redesign");
        try {
          createLegacyComponents(fixture.path, version);
          const before = fixture.withRaw((raw) => {
            raw.exec("PRAGMA journal_mode=DELETE");
            expect(raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
            return {
              records: raw.query("SELECT * FROM entities ORDER BY id").all(),
              addresses: raw.query("SELECT * FROM entity_refs ORDER BY ref").all(),
              comments: raw.query("SELECT * FROM task_comments ORDER BY sequence").all(),
              receipts: raw.query("SELECT * FROM batch_receipts ORDER BY operation_key").all(),
              state: raw.query("SELECT * FROM project_state").get(),
            };
          });
          const bytes = readFileSync(fixture.path);
          expect(readdirSync(fixture.directory)).toEqual(["project.sqlite"]);

          const failure = expectRelayError(() => {
            const unexpected = ProjectDatabase[method](fixture.path);
            unexpected.close();
          }, "SCHEMA_VERSION_UNSUPPORTED");

          expect(failure.details).toMatchObject({ expectedVersion: 6, actualVersion: version });
          expect(readFileSync(fixture.path)).toEqual(bytes);
          expect(readdirSync(fixture.directory)).toEqual(["project.sqlite"]);
          fixture.withRaw((raw) => {
            expect(raw.query("PRAGMA user_version").get()).toEqual({ user_version: version });
            expect(raw.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
            expect({
              records: raw.query("SELECT * FROM entities ORDER BY id").all(),
              addresses: raw.query("SELECT * FROM entity_refs ORDER BY ref").all(),
              comments: raw.query("SELECT * FROM task_comments ORDER BY sequence").all(),
              receipts: raw.query("SELECT * FROM batch_receipts ORDER BY operation_key").all(),
              state: raw.query("SELECT * FROM project_state").get(),
            }).toEqual(before);
            expect(
              raw.query("SELECT name FROM sqlite_schema WHERE name='entity_components'").all(),
            ).toEqual([]);
          });
        } finally {
          fixture.close();
        }
      },
    );
  }

  test.each(corruptedVersionCases)(
    "v3 отклоняется по версии до разбора повреждённых данных: $name",
    ({ sql }) => {
      const fixture = new ProjectDatabaseFixture("legacy-corruption", "database-redesign");
      try {
        createLegacyComponents(fixture.path, 3);
        fixture.withRaw((raw) => {
          // Проверка заголовка должна предшествовать чтению и исправлению прежней истории.
          raw.exec(sql);
          raw.exec("PRAGMA journal_mode=DELETE");
        });
        const bytes = readFileSync(fixture.path);

        const failure = expectRelayError(() => fixture.open(), "SCHEMA_VERSION_UNSUPPORTED");

        expect(failure.details).toMatchObject({ expectedVersion: 6, actualVersion: 3 });
        expect(readFileSync(fixture.path)).toEqual(bytes);
        expect(readdirSync(fixture.directory)).toEqual(["project.sqlite"]);
      } finally {
        fixture.close();
      }
    },
  );
});
