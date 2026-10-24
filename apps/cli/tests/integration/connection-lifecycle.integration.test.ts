import { describe, expect, spyOn, test } from "bun:test";
import { createCommandContext } from "gunshi/context";
import { KnowledgeService } from "@relay/core";
import { ProjectDatabase } from "@relay/storage";
import { Invocation } from "../../src/execution/invocation";
import { withCliFixture } from "./helpers/cli-fixture";
import { entityValue } from "./helpers/responses";

const firstAccesses = ["location", "db"] as const;

describe("Владение рабочим соединением CLI", () => {
  test.each(firstAccesses)(
    "первый доступ к %s лениво открывает единый проект для location и db",
    async (first) => {
      await withCliFixture(async (cli) => {
        const project = cli.createProject();
        const context = await createCommandContext({ command: { name: "fixture" } });
        const invocation = new Invocation(context, cli.runtime, {});
        const open = spyOn(ProjectDatabase, "open");
        const close = spyOn(ProjectDatabase.prototype, "close");
        try {
          try {
            expect(open).not.toHaveBeenCalled();
            void invocation[first];
            const location = invocation.location;
            const database = invocation.db;

            expect(location).toEqual(project);
            expect(invocation.location).toBe(location);
            expect(invocation.db).toBe(database);
            expect(database.get("PROJECT")?.id).toBe(project.projectId);
            expect(open).toHaveBeenCalledTimes(1);
            expect(close).not.toHaveBeenCalled();
          } finally {
            invocation.close();
          }
          expect(close).toHaveBeenCalledTimes(1);
        } finally {
          open.mockRestore();
          close.mockRestore();
        }
      }, "get-batch/cli-open-project");
    },
  );

  test("страница и продолжение используют одно соединение, закрытое после успешного результата", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const first = await cli.withDatabase(project, async (db) => {
        const knowledge = new KnowledgeService(db);
        const first = await knowledge.create(
          "document",
          { name: "Первый", body: "Содержание" },
          "fixture",
        );
        await knowledge.create("document", { name: "Второй", body: "Содержание" }, "fixture");
        return first;
      });
      const open = spyOn(ProjectDatabase, "open");
      const close = spyOn(ProjectDatabase.prototype, "close");
      try {
        const page = await cli.page(["document", "list", "--limit", "1"], entityValue);

        expect(page.data.items).toEqual([first]);
        expect(page.meta.page.nextCommand).toContain(project.configPath);
        expect(open).toHaveBeenCalledTimes(1);
        expect(close).toHaveBeenCalledTimes(1);
      } finally {
        open.mockRestore();
        close.mockRestore();
      }
    }, "get-batch/cli-open-project");
  });

  test("отказ предметного чтения закрывает единственное рабочее соединение", async () => {
    await withCliFixture(async (cli) => {
      cli.createProject();
      const open = spyOn(ProjectDatabase, "open");
      const close = spyOn(ProjectDatabase.prototype, "close");
      try {
        const error = await cli.error(["document", "get", "missing"], 3);

        expect(error.code).toBe("NOT_FOUND");
        expect(open).toHaveBeenCalledTimes(1);
        expect(close).toHaveBeenCalledTimes(1);
      } finally {
        open.mockRestore();
        close.mockRestore();
      }
    }, "get-batch/cli-open-project");
  });

  test("config get сохраняет проверочное открытие и закрытие без рабочего соединения Invocation", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const open = spyOn(ProjectDatabase, "open");
      const close = spyOn(ProjectDatabase.prototype, "close");
      try {
        const response = await cli.success(["config", "get"]);

        expect(response.data).toEqual({ version: 1, projectId: project.projectId });
        expect(response.meta).toEqual({ ...project });
        expect(open).toHaveBeenCalledTimes(1);
        expect(close).toHaveBeenCalledTimes(1);
      } finally {
        open.mockRestore();
        close.mockRestore();
      }
    }, "get-batch/cli-open-project");
  });
});
