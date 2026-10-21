import { expect, test } from "bun:test";
import { join } from "node:path";
import { TasksService } from "@relay/core";
import { withCliFixture } from "./helpers/cli-fixture";
import { entityValue, successValue } from "./helpers/responses";

test.each(["до", "между", "после"] as const)(
  "глобальные параметры %s имён команды имеют приоритет над env",
  (position) =>
    withCliFixture(async (cli) => {
      const project = cli.createProject();
      const globals = ["--config", project.configPath, "--actor", "task", "--format", "json"];
      const command = ["create", "--title", "Разбор параметров"];
      const argv =
        position === "до"
          ? [...globals, "task", ...command]
          : position === "между"
            ? ["task", ...globals, ...command]
            : ["task", ...command, ...globals];
      const answer = await cli.invoke(argv, {
        env: {
          ...cli.runtime.env,
          RELAY_CONFIG: join(cli.root, "missing.json"),
          RELAY_ACTOR: "environment",
        },
      });
      expect(answer).toMatchObject({ code: 0, stderr: "" });
      // Значение автора совпадает с именем команды: Gunshi должен сохранить его как значение флага.
      const entity = entityValue(successValue(JSON.parse(answer.stdout)).data);
      expect(entity.createdBy).toBe("task");
      expect(cli.withDatabase(project, (db) => db.get(entity.id)?.createdBy)).toBe("task");
    }),
);

test("конфигурация и автор из окружения используются без соответствующих флагов", () =>
  withCliFixture(async (cli) => {
    const project = cli.createProject();
    const entity = await cli.entity(["task", "create", "--title", "Автор окружения"], {
      cwd: cli.root,
      env: { ...cli.runtime.env, RELAY_CONFIG: project.configPath, RELAY_ACTOR: "environment" },
    });
    expect(entity.createdBy).toBe("environment");
    expect(cli.withDatabase(project, (db) => db.get(entity.id)?.data.title)).toBe(
      "Автор окружения",
    );
  }));

test.each(["неизвестный флаг", "лишний аргумент"])(
  "%s отклоняется до изменения проекта",
  (variant) =>
    withCliFixture(async (cli) => {
      const project = cli.createProject();
      const task = cli.withDatabase(project, (db) =>
        new TasksService(db).create({ title: "Исходная" }, "agent"),
      );
      const generation = cli.withDatabase(project, (db) => db.getGeneration());
      const argv =
        variant === "неизвестный флаг"
          ? ["task", "create", "--titel", "Опечатка"]
          : ["task", "get", task.key, "лишний"];
      expect((await cli.error(argv, 2)).code).toBe("INVALID_ARGUMENT");
      expect(cli.withDatabase(project, (db) => db.getGeneration())).toBe(generation);
    }),
);
