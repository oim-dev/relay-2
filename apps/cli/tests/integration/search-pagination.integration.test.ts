import { describe, expect, spyOn, test } from "bun:test";
import { KnowledgeService, QueryService } from "@relay/core";
import { withCliFixture } from "./helpers/cli-fixture";
import { entityValue, stringValue } from "./helpers/responses";

const invalidContinuations = [
  {
    name: "другой запрос",
    query: "Другой",
    changeData: false,
    exitCode: 2,
    code: "INVALID_CURSOR",
  },
  {
    name: "устаревшее поколение",
    query: "Поиск",
    changeData: true,
    exitCode: 4,
    code: "SNAPSHOT_CONFLICT",
  },
] as const;

describe("Проверка курсора до вычисления поиска", () => {
  test("повреждённый курсор отклоняется до чтения поискового состава Core", async () => {
    await withCliFixture(async (cli) => {
      cli.createProject();
      const search = spyOn(QueryService.prototype, "search");
      try {
        const error = await cli.error(["search", "--q", "Поиск", "--cursor", "broken"], 2);

        expect(error.code).toBe("INVALID_CURSOR");
        expect(search).not.toHaveBeenCalled();
      } finally {
        search.mockRestore();
      }
    });
  });

  test.each(invalidContinuations)(
    "$name отклоняется без повторного предметного поиска",
    async ({ query, changeData, exitCode, code }) => {
      await withCliFixture(async (cli) => {
        const project = cli.createProject();
        await cli.withDatabase(project, async (db) => {
          const knowledge = new KnowledgeService(db);
          await knowledge.create("feature", { name: "Поиск первый" }, "fixture");
          await knowledge.create("feature", { name: "Поиск второй" }, "fixture");
        });
        const first = await cli.page(["search", "--q", "Поиск", "--limit", "1"], entityValue);
        const cursor = stringValue(first.meta.page.nextCursor);
        if (changeData) {
          await cli.withDatabase(project, async (db) => {
            await new KnowledgeService(db).create("feature", { name: "Новая запись" }, "fixture");
          });
        }
        const search = spyOn(QueryService.prototype, "search");
        try {
          const error = await cli.error(["search", "--q", query, "--cursor", cursor], exitCode);

          expect(error.code).toBe(code);
          expect(search).not.toHaveBeenCalled();
        } finally {
          search.mockRestore();
        }
      });
    },
  );

  test("действительное продолжение вычисляет поиск один раз и возвращает следующее окно", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const expected = await cli.withDatabase(project, async (db) => {
        const knowledge = new KnowledgeService(db);
        return [
          await knowledge.create("feature", { name: "Поиск первый" }, "fixture"),
          await knowledge.create("feature", { name: "Поиск второй" }, "fixture"),
        ];
      });
      const first = await cli.page(["search", "--q", "Поиск", "--limit", "1"], entityValue);
      const cursor = stringValue(first.meta.page.nextCursor);
      const search = spyOn(QueryService.prototype, "search");
      try {
        const second = await cli.page(["search", "--q", "Поиск", "--cursor", cursor], entityValue);

        expect(first.data.items).toEqual(expected.slice(0, 1));
        expect(second.data.items).toEqual(expected.slice(1));
        expect(second.meta.page).toMatchObject({ count: 1, total: 2, limit: 1, nextCursor: null });
        expect(search).toHaveBeenCalledTimes(1);
      } finally {
        search.mockRestore();
      }
    });
  });
});
