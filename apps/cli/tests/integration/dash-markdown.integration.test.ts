import { describe, expect, test } from "bun:test";
import { KnowledgeService } from "@relay/core";
import { withCliFixture } from "./helpers/cli-fixture";

describe("Передача Markdown с начальным дефисом", () => {
  test("отказ не меняет документ, а рекомендованная форма с равенством сохраняет точный текст", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const before = cli.withDatabase(project, (db) => ({
        document: new KnowledgeService(db).create(
          "document",
          { name: "Список", body: "До изменения" },
          "agent",
        ),
        generation: db.getGeneration(),
      }));
      const body = "- [ ] Проверить 'кавычки' 😀  \n\n    $(не исполнять)\n- [x] Готово\n";
      const argv = [
        "document",
        "update",
        before.document.key,
        "--if-revision",
        String(before.document.revision),
      ];

      const failure = await cli.error([...argv, "--body", body], 2);

      expect(failure.code).toBe("INVALID_ARGUMENT");
      expect(failure.message).toContain("--body= с исходным текстом в shell-кавычках");
      expect(cli.withDatabase(project, (db) => db.get(before.document.id))).toEqual(
        before.document,
      );
      expect(cli.withDatabase(project, (db) => db.getGeneration())).toBe(before.generation);

      const updated = await cli.entity([...argv, `--body=${body}`]);

      expect(updated.data.body).toBe(body);
      expect(updated.revision).toBe(before.document.revision + 1);
      expect(cli.withDatabase(project, (db) => db.get(before.document.id))).toEqual(updated);
    });
  });
});
