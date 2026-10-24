import { describe, expect, spyOn, test } from "bun:test";
import { KnowledgeService } from "@relay/core";
import { ProjectDatabase } from "@relay/storage";
import { withCliFixture } from "./helpers/cli-fixture";
import { entityValue, readEntitiesValue } from "./helpers/responses";

const singletonKinds = [
  { name: "паспорт проекта", kind: "project" },
  { name: "паспорт продукта", kind: "product" },
] as const;

describe("Однократное чтение знаний в адаптере CLI", () => {
  test.each(singletonKinds)(
    "$name переименовывается без предварительного полного get в CLI",
    async ({ kind }) => {
      await withCliFixture(async (cli) => {
        const project = cli.createProject();
        const initial = cli.withDatabase(project, (db) => new KnowledgeService(db).get(kind));
        const read = spyOn(ProjectDatabase.prototype, "get");
        const originalOpen = ProjectDatabase.open;
        const restoreLoads: (() => void)[] = [];
        let fullOwnerLoads = 0;
        const open = spyOn(ProjectDatabase, "open").mockImplementation((path) => {
          const database = originalOpen.call(ProjectDatabase, path);
          const load = database.commands.load.bind(database.commands);
          const observed = spyOn(database.commands, "load").mockImplementation(async (request) => {
            const loaded = await load(request);
            for (const observation of loaded.observations) {
              if (observation.kind === "records") {
                fullOwnerLoads += observation.records.filter(
                  (record) => record.id === initial.id,
                ).length;
              }
            }
            return loaded;
          });
          restoreLoads.push(() => observed.mockRestore());
          return database;
        });
        try {
          const renamed = await cli.entity([
            kind,
            "rename",
            "PASSPORT-RENAMED",
            "--if-revision",
            String(initial.revision),
          ]);

          expect(renamed).toMatchObject({
            id: initial.id,
            key: "PASSPORT-RENAMED",
            revision: initial.revision + 1,
            data: initial.data,
          });
          // Полная карточка теперь загружается command port, а не legacy ProjectDatabase.get.
          expect(read).not.toHaveBeenCalled();
          expect(fullOwnerLoads).toBe(1);
        } finally {
          for (const restore of restoreLoads) {
            restore();
          }
          open.mockRestore();
          read.mockRestore();
        }
        expect((await cli.entity([kind, "get"])).key).toBe("PASSPORT-RENAMED");
        const resolved = readEntitiesValue((await cli.success(["get", initial.key])).data);
        expect(resolved).toHaveLength(1);
        expect(resolved[0]?.id).toBe(initial.id);
      }, "get-batch");
    },
  );

  test("страница участия получает приложение и его ревизию без повторного чтения карточки", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const expected = await cli.withDatabase(project, async (db) => {
        const knowledge = new KnowledgeService(db);
        const first = await knowledge.create("feature", { name: "Поиск" }, "fixture");
        const second = await knowledge.create("feature", { name: "Каталог" }, "fixture");
        const application = await knowledge.create(
          "application",
          { name: "Витрина", slug: "web" },
          "fixture",
        );
        const owner = await knowledge.replaceParticipation(application.id, [first.id, second.id], {
          actor: "fixture",
          ifRevision: application.revision,
        });
        return {
          owner,
          items: knowledge.list("implementation", { application: owner.id, active: true }),
        };
      });
      const read = spyOn(ProjectDatabase.prototype, "get");
      try {
        const page = await cli.page(
          ["application", "participation", "list", expected.owner.key, "--limit", "1"],
          entityValue,
        );

        expect(page.data).toEqual({
          application: expected.owner.key,
          revision: expected.owner.revision,
          items: expected.items.slice(0, 1),
        });
        expect(page.meta.page).toMatchObject({ count: 1, total: 2, limit: 1 });
        expect(page.meta.page.nextCursor).not.toBeNull();
        expect(read).toHaveBeenCalledTimes(1);
      } finally {
        read.mockRestore();
      }
    });
  });
});
