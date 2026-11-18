import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ProjectDatabase } from "../../src/database/project-database";
import { createLegacyComponents } from "./helpers/components-legacy-fixture";
import { ProjectDatabaseFixture, expectRelayError } from "./helpers/project-database-fixture";

const openingMethods = [
  { name: "обычное открытие", method: "open" },
  { name: "readonly открытие", method: "openReadonly" },
] as const;

/**
 * Готовит настоящую историческую v2 с изменением документа только в committed WAL.
 * После синхронного COMMIT других писателей нет: main и WAL копируются до закрытия
 * исходного соединения, которое иначе выполнит checkpoint и удалит WAL. Отсутствующий SHM
 * моделирует восстановление SQLite после потери процесса; это не общий backup helper.
 * Соединение закрывается здесь, исходные и скопированные файлы удаляет вызывающий fixture.
 */
function createLegacyDatabaseWithCommittedWal(path: string, body: string): void {
  const sourcePath = join(dirname(path), "source.sqlite");
  createLegacyComponents(sourcePath, 2);
  const source = new Database(sourcePath, { create: false, readwrite: true, strict: true });
  try {
    source.exec("PRAGMA foreign_keys=ON; PRAGMA wal_autocheckpoint=0");
    expect(source.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    const mainBeforeWrite = readFileSync(sourcePath);

    source
      .transaction(() => {
        source
          .query(
            "UPDATE entities SET revision=revision+1, data=json_set(data,'$.body',?) WHERE id='legacy-document'",
          )
          .run(body);
      })
      .immediate();

    expect(source.inTransaction).toBe(false);
    expect(
      source
        .query("SELECT revision,json_extract(data,'$.body') AS body FROM entities WHERE id=?")
        .get("legacy-document"),
    ).toEqual({ revision: 2, body });
    expect(source.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(readFileSync(sourcePath).equals(mainBeforeWrite)).toBe(true);
    expect(readFileSync(`${sourcePath}-wal`).length).toBeGreaterThan(32);

    copyFileSync(sourcePath, path);
    copyFileSync(`${sourcePath}-wal`, `${path}-wal`);
  } finally {
    source.close();
  }
}

describe("Сохранность несовместимой базы с committed WAL", () => {
  test.each(openingMethods)(
    "$name отклоняет v2 без checkpoint, потери WAL или изменения committed документа",
    ({ method }) => {
      const fixture = new ProjectDatabaseFixture(
        "incompatible-wal",
        "database-redesign/test-review",
      );
      try {
        const body = "# Сохранить committed WAL\r\n\tПоследняя редакция  \r\n";
        createLegacyDatabaseWithCommittedWal(fixture.path, body);
        const walPath = `${fixture.path}-wal`;
        const mainBefore = readFileSync(fixture.path);
        const walBefore = readFileSync(walPath);
        expect(existsSync(`${fixture.path}-shm`)).toBe(false);

        const failure = expectRelayError(() => {
          const unexpected = ProjectDatabase[method](fixture.path);
          unexpected.close();
        }, "SCHEMA_VERSION_UNSUPPORTED");

        expect(failure.details).toMatchObject({ expectedVersion: 6, actualVersion: 2 });
        expect(readFileSync(fixture.path).equals(mainBefore)).toBe(true);
        expect(existsSync(walPath)).toBe(true);
        expect(readFileSync(walPath).equals(walBefore)).toBe(true);
        // SHM — восстанавливаемый кеш SQLite; контракт сохраняет предметную БД и committed WAL.
        const preserved = new Database(fixture.path, { readonly: true, strict: true });
        try {
          expect(preserved.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
          expect(
            preserved
              .query("SELECT revision,json_extract(data,'$.body') AS body FROM entities WHERE id=?")
              .get("legacy-document"),
          ).toEqual({ revision: 2, body });
        } finally {
          preserved.close();
        }
      } finally {
        fixture.close();
      }
    },
  );
});
