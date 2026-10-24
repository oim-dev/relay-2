import { describe, expect, spyOn, test } from "bun:test";
import { KnowledgeService, PlanningService, QueryService, TasksService } from "@relay/core";
import type { CommandEntityVersions } from "@relay/contracts";
import { ProjectDatabase } from "@relay/storage";
import { withCliFixture } from "./helpers/cli-fixture";
import { objectValue, stringValue } from "./helpers/responses";
import type { SuccessResponse } from "./helpers/responses.types";
import type { TransferVersionFixture } from "./helpers/portable-versions.types";

const group = "git-sync-implementation/cli-runtime/commands/ver04";

/**
 * Читает непрозрачную metadata ровно выбранного ID, не вычисляя токен из показанной проекции.
 */
function versionsOf(response: SuccessResponse, id: string): CommandEntityVersions {
  const versions = objectValue(objectValue(response.meta).versions);
  const value = objectValue(versions[id]);
  return {
    recordVersion: stringValue(value.recordVersion),
    aggregateVersion: stringValue(value.aggregateVersion),
  };
}

/**
 * Подготавливает реальные исходный/целевой планы через legacy numeric API; соединение принадлежит fixture.
 */
async function transferFixture(db: ProjectDatabase): Promise<TransferVersionFixture> {
  const planning = new PlanningService(db);
  const task = await new TasksService(db).create({ title: "Переносимая задача" }, "fixture");
  let source = await planning.create("work-plan", { title: "Исходный" }, "fixture");
  source = await planning.stage(
    source.id,
    "create",
    { title: "Исходный этап" },
    { actor: "fixture", ifRevision: source.revision },
  );
  const sourceStage = source.data.stages[0];
  if (!sourceStage) {
    throw new Error("Не создан исходный этап");
  }
  source = await planning.stageTask(source.id, sourceStage.id, task.id, false, {
    actor: "fixture",
    ifRevision: source.revision,
  });
  let target = await planning.create("work-plan", { title: "Целевой" }, "fixture");
  target = await planning.stage(
    target.id,
    "create",
    { title: "Целевой этап" },
    { actor: "fixture", ifRevision: target.revision },
  );
  const targetStage = target.data.stages[0];
  if (!targetStage) {
    throw new Error("Не создан целевой этап");
  }
  return { source, target, targetStage: targetStage.id, task };
}

describe("Переносимые предусловия CLI", () => {
  test("смена read anchor не публикует смешанную projection/metadata", async () => {
    await withCliFixture(async (fixture) => {
      const project = fixture.createProject();
      const document = await fixture.withDatabase(
        project,
        async (db) =>
          await new KnowledgeService(db).create(
            "document",
            { name: "Согласованное чтение", body: "До параллельной записи" },
            "fixture",
          ),
      );
      const other = ProjectDatabase.open(project.databasePath);
      const openProject = ProjectDatabase.open;
      const restoreLoads: (() => void)[] = [];
      let changed = false;
      const open = spyOn(ProjectDatabase, "open").mockImplementation((path) => {
        const database = openProject.call(ProjectDatabase, path);
        const originalLoad = database.commands.load.bind(database.commands);
        const load = spyOn(database.commands, "load").mockImplementation(async (request) => {
          const loaded = await originalLoad(request);
          if (!changed && request.anchor === null) {
            // Коммит второго соединения происходит между настоящими async load одного get.
            other.transaction(() => {
              const current = other.get(document.id);
              if (!current) {
                throw new Error("Нет подготовленного документа");
              }
              other.update(
                {
                  ...current,
                  revision: current.revision + 1,
                  data: { ...current.data, body: "Параллельная запись" },
                },
                current.revision,
              );
            });
            changed = true;
          }
          return loaded;
        });
        restoreLoads.push(() => load.mockRestore());
        return database;
      });
      try {
        const failure = await fixture.error(["get", document.id, "--with-versions"], 4);

        expect(changed).toBe(true);
        expect(failure.code).toBe("COMMAND_CONTEXT_CHANGED");
        expect(other.get(document.id)?.data.body).toBe("Параллельная запись");
      } finally {
        for (const restore of restoreLoads) {
          restore();
        }
        open.mockRestore();
        other.close();
      }
    }, group);
  });

  test("single get metadata сохраняет effective projection и отделена от raw data", async () => {
    await withCliFixture(async (fixture) => {
      const project = fixture.createProject();
      const document = await fixture.withDatabase(project, async (db) => {
        const knowledge = new KnowledgeService(db);
        const passport = await knowledge.changeSection(
          "create",
          { id: "retired", name: "Архивный раздел" },
          { actor: "fixture", ifRevision: knowledge.get("project").revision },
        );
        const document = await knowledge.create(
          "document",
          { name: "Историческая ссылка", body: "  Полное тело\r\n", sectionId: "retired" },
          "fixture",
        );
        await knowledge.changeSection(
          "remove",
          { id: "retired" },
          { actor: "fixture", ifRevision: passport.revision },
        );
        return document;
      });
      const versionedRead = spyOn(QueryService.prototype, "getManyVersioned");
      let legacy: SuccessResponse;
      try {
        legacy = await fixture.success(["get", document.id]);
        expect(versionedRead).not.toHaveBeenCalled();
        expect(legacy.meta).toBeUndefined();
      } finally {
        versionedRead.mockRestore();
      }
      const legacyRead = spyOn(QueryService.prototype, "getMany");
      let versioned: SuccessResponse;
      try {
        versioned = await fixture.success(["get", document.id, "--with-versions"]);
        expect(legacyRead).not.toHaveBeenCalled();
      } finally {
        legacyRead.mockRestore();
      }

      expect(versioned.data).toEqual(legacy.data);
      expect(Object.keys(objectValue(objectValue(versioned.meta).versions))).toEqual([document.id]);
      const token = versionsOf(versioned, document.id).aggregateVersion;
      expect(token.length).toBeGreaterThan(0);
      expect(objectValue(versioned.data).items).toEqual([
        expect.objectContaining({
          ok: true,
          entity: expect.objectContaining({
            data: expect.objectContaining({ sectionId: null, body: "  Полное тело\r\n" }),
          }),
        }),
      ]);
      const stored = fixture.withDatabase(project, (db) => db.get(document.id));
      expect(stored?.data.sectionId).toBe("retired");
      expect(stored).not.toHaveProperty("versions");
      expect(stored?.data).not.toHaveProperty("aggregateVersion");
      const text = await fixture.invoke(["get", document.id, "--summary", "--with-versions"]);
      expect(text.code).toBe(0);
      expect(text.stdout).toContain(`Версия агрегата (expectedVersion): ${token}`);
      expect(text.stdout).not.toContain("Полное тело");
    }, group);
  });

  test.each([false, true])(
    "versioned group get сохраняет порядок, повторы, ошибки и view (summary=%s)",
    async (summary) => {
      await withCliFixture(async (fixture) => {
        const project = fixture.createProject();
        const { document, task } = await fixture.withDatabase(project, async (db) => ({
          document: await new KnowledgeService(db).create(
            "document",
            { name: "Документ", body: "Скрывать только в summary" },
            "fixture",
          ),
          task: await new TasksService(db).create({ title: "Задача" }, "fixture"),
        }));
        const args = [
          "get",
          document.key,
          "missing",
          task.key,
          document.id,
          ...(summary ? ["--summary"] : []),
          "--format",
          "json",
        ];
        const legacy = await fixture.invoke(args);
        const legacyRead = spyOn(QueryService.prototype, "getMany");
        try {
          const versioned = await fixture.invoke([...args, "--with-versions"]);

          expect(versioned.code).toBe(3);
          const before = objectValue(JSON.parse(legacy.stdout));
          const after = objectValue(JSON.parse(versioned.stdout));
          expect(after.data).toEqual(before.data);
          expect(after.error).toEqual(before.error);
          expect(Object.keys(objectValue(objectValue(after.meta).versions)).sort()).toEqual(
            [document.id, task.id].sort(),
          );
          expect(legacyRead).not.toHaveBeenCalled();
        } finally {
          legacyRead.mockRestore();
        }
      }, group);
    },
  );

  test("stale aggregateVersion отвергает даже no-op без записи и без numeric CAS", async () => {
    await withCliFixture(async (fixture) => {
      const project = fixture.createProject();
      const initial = await fixture.withDatabase(
        project,
        async (db) =>
          await new KnowledgeService(db).create(
            "document",
            { name: "Версии", body: "Было" },
            "fixture",
          ),
      );
      const old = versionsOf(
        await fixture.success(["get", initial.id, "--with-versions"]),
        initial.id,
      );
      const current = await fixture.withDatabase(
        project,
        async (db) =>
          await new KnowledgeService(db).update(
            "document",
            initial.id,
            { body: "Стало" },
            { actor: "other", ifRevision: initial.revision },
          ),
      );
      const generation = fixture.withDatabase(project, (db) => db.getGeneration());

      const error = await fixture.error(
        [
          "document",
          "update",
          initial.id,
          "--body",
          "Стало",
          "--expected-version",
          old.aggregateVersion,
        ],
        4,
      );

      expect(error.code).toBe("VERSION_CONFLICT");
      expect(fixture.withDatabase(project, (db) => db.get(initial.id))).toEqual(current);
      expect(fixture.withDatabase(project, (db) => db.getGeneration())).toBe(generation);

      const reviewed = versionsOf(
        await fixture.success(["get", initial.id, "--summary", "--with-versions"]),
        initial.id,
      );
      const updated = await fixture.entity([
        "document",
        "update",
        initial.id,
        "--body",
        "Следующая редакция",
        "--expected-version",
        reviewed.aggregateVersion,
      ]);
      expect(updated).toMatchObject({
        id: initial.id,
        revision: current.revision + 1,
        data: { body: "Следующая редакция" },
      });
    }, group);
  });

  test("creation существующего product owner передаёт constructor token без fresh numeric CAS", async () => {
    await withCliFixture(async (fixture) => {
      const project = fixture.createProject();
      const seed = fixture.withDatabase(project, (db) => new KnowledgeService(db).get("product"));
      const token = versionsOf(
        await fixture.success(["get", seed.id, "--with-versions", "--summary"]),
        seed.id,
      ).aggregateVersion;

      expect(
        (
          await fixture.error(
            ["product", "create", "--name", "Продукт", "--expected-version", "stale-token"],
            4,
          )
        ).code,
      ).toBe("VERSION_CONFLICT");
      expect(fixture.withDatabase(project, (db) => db.get(seed.id))).toEqual(seed);
      const created = await fixture.entity([
        "product",
        "create",
        "--name",
        "Продукт",
        "--expected-version",
        token,
      ]);

      expect(created).toMatchObject({ id: seed.id, kind: "product", data: { name: "Продукт" } });
    }, group);
  });

  test("оба CAS и address guard проверяются независимо, successful payload остаётся entity", async () => {
    await withCliFixture(async (fixture) => {
      const project = fixture.createProject();
      const initial = await fixture.withDatabase(
        project,
        async (db) =>
          await new KnowledgeService(db).create(
            "document",
            { name: "Два предусловия", body: "Было" },
            "fixture",
          ),
      );
      const versions = versionsOf(
        await fixture.success(["get", initial.id, "--with-versions", "--summary"]),
        initial.id,
      );
      const args = ["document", "update", initial.key, "--body", "Стало"];

      expect(
        (
          await fixture.error(
            [
              ...args,
              "--if-revision",
              String(initial.revision + 1),
              "--expected-version",
              versions.aggregateVersion,
            ],
            4,
          )
        ).code,
      ).toBe("REVISION_CONFLICT");
      expect(
        (
          await fixture.error(
            [
              ...args,
              "--if-revision",
              String(initial.revision),
              "--expected-version",
              "stale-token",
            ],
            4,
          )
        ).code,
      ).toBe("VERSION_CONFLICT");
      expect(
        (
          await fixture.error(
            [
              ...args,
              "--expected-version",
              versions.aggregateVersion,
              "--expected-addresses",
              JSON.stringify([{ ref: initial.key, expectedId: "wrong-id" }]),
            ],
            4,
          )
        ).code,
      ).toBe("ADDRESS_CHANGED");
      expect(fixture.withDatabase(project, (db) => db.get(initial.id))).toEqual(initial);

      const updated = await fixture.entity([
        ...args,
        "--if-revision",
        String(initial.revision),
        "--expected-version",
        versions.aggregateVersion,
        "--expected-addresses",
        JSON.stringify([{ ref: initial.key, expectedId: initial.id }]),
      ]);

      expect(updated).toMatchObject({
        id: initial.id,
        kind: "document",
        revision: initial.revision + 1,
        data: { body: "Стало" },
      });
    }, group);
  });

  test("transfer проверяет token целевого владельца и обе target формы до атомарного переноса", async () => {
    await withCliFixture(async (fixture) => {
      const project = fixture.createProject();
      const prepared = await fixture.withDatabase(project, transferFixture);
      const read = await fixture.success([
        "get",
        prepared.source.id,
        prepared.target.id,
        "--summary",
        "--with-versions",
      ]);
      const source = versionsOf(read, prepared.source.id).aggregateVersion;
      const target = versionsOf(read, prepared.target.id).aggregateVersion;
      const args = [
        "plan",
        "stage",
        "task",
        "transfer",
        prepared.source.id,
        prepared.task.id,
        prepared.targetStage,
        "--target-plan",
        prepared.target.id,
        "--reason",
        "Перенос по прочитанным версиям",
        "--expected-version",
        source,
      ];

      expect(
        (
          await fixture.error(
            [
              ...args,
              "--target-version",
              source,
              "--target-revision",
              String(prepared.target.revision),
            ],
            4,
          )
        ).code,
      ).toBe("VERSION_CONFLICT");
      expect(
        (
          await fixture.error(
            [
              ...args,
              "--target-version",
              target,
              "--target-revision",
              String(prepared.target.revision + 1),
            ],
            4,
          )
        ).code,
      ).toBe("REVISION_CONFLICT");
      expect(
        fixture.withDatabase(project, (db) => ({
          source: new PlanningService(db).get("work-plan", prepared.source.id),
          target: new PlanningService(db).get("work-plan", prepared.target.id),
        })),
      ).toEqual({ source: prepared.source, target: prepared.target });

      const transferred = await fixture.success([...args, "--target-version", target]);

      expect(transferred.data).toMatchObject({
        source: { id: prepared.source.id },
        target: { id: prepared.target.id },
      });
      fixture.withDatabase(project, (db) => {
        const planning = new PlanningService(db);
        expect(planning.get("work-plan", prepared.source.id).data.stages[0]?.taskIds).toEqual([]);
        expect(planning.get("work-plan", prepared.target.id).data.stages[0]?.taskIds).toEqual([
          prepared.task.id,
        ]);
        expect(new TasksService(db).get(prepared.task.id)).toEqual(prepared.task);
      });
    }, group);
  });
});
