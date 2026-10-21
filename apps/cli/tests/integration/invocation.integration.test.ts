import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { TasksService } from "@relay/core";
import { withCliFixture } from "./helpers/cli-fixture";
import { entityValue, successValue } from "./helpers/responses";

const globalPositions = [
  { name: "до команды", before: [], after: ["task", "create", "--title", "Разбор параметров"] },
  {
    name: "между именами команды",
    before: ["task"],
    after: ["create", "--title", "Разбор параметров"],
  },
  { name: "после команды", before: ["task", "create", "--title", "Разбор параметров"], after: [] },
] as const;

describe("Аргументы вызова CLI", () => {
  test.each(globalPositions)(
    "глобальные параметры $name имеют приоритет над env",
    async ({ before, after }) => {
      await withCliFixture(async (cli) => {
        const project = cli.createProject();
        // Автор совпадает с именем команды: Gunshi должен сохранить его как значение флага.
        const globals = ["--config", project.configPath, "--actor", "task", "--format", "json"];
        const argv = [...before, ...globals, ...after];

        const answer = await cli.invoke(argv, {
          env: {
            ...cli.runtime.env,
            RELAY_CONFIG: join(cli.root, "missing.json"),
            RELAY_ACTOR: "environment",
          },
        });

        expect(answer).toMatchObject({ code: 0, stderr: "" });
        const entity = entityValue(successValue(JSON.parse(answer.stdout)).data);
        expect(entity.createdBy).toBe("task");
        expect(cli.withDatabase(project, (db) => db.get(entity.id)?.createdBy)).toBe("task");
      });
    },
  );

  test("конфигурация и автор из окружения используются без соответствующих флагов", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();

      const entity = await cli.entity(["task", "create", "--title", "Автор окружения"], {
        cwd: cli.root,
        env: { ...cli.runtime.env, RELAY_CONFIG: project.configPath, RELAY_ACTOR: "environment" },
      });

      expect(entity.createdBy).toBe("environment");
      expect(cli.withDatabase(project, (db) => db.get(entity.id)?.data.title)).toBe(
        "Автор окружения",
      );
    });
  });

  test("неизвестный флаг создания отклоняется до изменения проекта", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const generation = cli.withDatabase(project, (db) => db.getGeneration());

      const error = await cli.error(["task", "create", "--titel", "Опечатка"], 2);

      expect(error.code).toBe("INVALID_ARGUMENT");
      expect(cli.withDatabase(project, (db) => db.getGeneration())).toBe(generation);
      expect(cli.withDatabase(project, (db) => db.list("task"))).toEqual([]);
    });
  });

  test("лишний позиционный аргумент чтения отклоняется без изменения задачи", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const task = cli.withDatabase(project, (db) =>
        new TasksService(db).create({ title: "Исходная" }, "agent"),
      );
      const generation = cli.withDatabase(project, (db) => db.getGeneration());

      const error = await cli.error(["task", "get", task.key, "лишний"], 2);

      expect(error.code).toBe("INVALID_ARGUMENT");
      expect(cli.withDatabase(project, (db) => db.getGeneration())).toBe(generation);
      expect(cli.withDatabase(project, (db) => db.get(task.id))).toEqual(task);
    });
  });
});
