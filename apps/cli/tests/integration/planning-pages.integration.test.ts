import { describe, expect, spyOn, test } from "bun:test";
import { PlanningService, TasksService } from "@relay/core";
import { ProjectDatabase } from "@relay/storage";
import { withCliFixture } from "./helpers/cli-fixture";
import { entityValue, stringValue } from "./helpers/responses";
import type { PlanningPageScenario } from "./helpers/planning-fixture.types";

const compositions = [
  { name: "задачи этапа", kind: "task", seed: seedStageTasks },
  { name: "планы релиза", kind: "work-plan", seed: seedReleasePlans },
] as const;

const rejectedCursors = [
  { name: "устаревший", stale: true, exitCode: 4, errorCode: "SNAPSHOT_CONFLICT" },
  { name: "повреждённый", stale: false, exitCode: 2, errorCode: "INVALID_CURSOR" },
] as const;

/**
 * Создаёт этап и две задачи в обратном порядке включения; соединением владеет CLI fixture.
 */
function seedStageTasks(db: ProjectDatabase): PlanningPageScenario {
  const tasks = new TasksService(db);
  const first = tasks.create({ title: "Первая задача", description: "Полное описание" }, "agent");
  const second = tasks.create({ title: "Вторая задача" }, "agent");
  const commented = tasks.comment(second.id, "Комментарий выбранной карточки", "agent");
  const items = [commented, first] as const;
  const planning = new PlanningService(db);
  let plan = planning.create("work-plan", { title: "План" }, "agent");
  plan = planning.stage(
    plan.id,
    "create",
    { title: "Этап" },
    { actor: "agent", ifRevision: plan.revision },
  );
  const stage = plan.data.stages[0];
  if (!stage) {
    throw new Error("Подготовка должна создать этап");
  }
  for (const task of items) {
    plan = planning.stageTask(plan.id, stage.id, task.id, false, {
      actor: "agent",
      ifRevision: plan.revision,
    });
  }
  return {
    command: ["plan", "stage", "task", "list", plan.key, stage.id],
    owner: { plan: plan.key, revision: plan.revision },
    items,
  };
}

/**
 * Создаёт два плана и релиз с обратным порядком включения; не изменяет жизненный цикл соединения.
 */
function seedReleasePlans(db: ProjectDatabase): PlanningPageScenario {
  const planning = new PlanningService(db);
  const first = planning.create("work-plan", { title: "Первый", goal: "Полная цель" }, "agent");
  const second = planning.create("work-plan", { title: "Второй" }, "agent");
  const release = planning.create(
    "release",
    { title: "Релиз", version: "1", planIds: [second.id, first.id] },
    "agent",
  );
  return {
    command: ["release", "plans", release.key],
    owner: { release: release.key, revision: release.revision },
    items: [second, first],
  };
}

describe("Страницы составов планирования через CLI", () => {
  test.each(compositions)(
    "$name: полный обход читает только карточки окна и сохраняет владельца",
    async ({ seed, kind }) => {
      await withCliFixture(async (cli) => {
        const project = cli.createProject();
        const { command, owner, items } = cli.withDatabase(project, seed);
        const read = spyOn(ProjectDatabase.prototype, "getMany");
        try {
          const first = await cli.page([...command, "--limit", "1"], entityValue);
          const last = await cli.page(
            [...command, "--cursor", stringValue(first.meta.page.nextCursor)],
            entityValue,
          );

          expect(first.data).toEqual({ ...owner, items: [items[0]] });
          expect(last.data).toEqual({ ...owner, items: [items[1]] });
          expect(first.meta.page).toMatchObject({ count: 1, total: 2, limit: 1 });
          expect(last.meta.page).toEqual({
            count: 1,
            total: 2,
            limit: 1,
            consistency: "snapshot",
            nextCursor: null,
            nextCommand: null,
          });
          expect(first.meta.page.nextCommand).toContain(command.join(" "));
          expect(first.meta.page.nextCommand).toContain(`--config=${project.configPath}`);
          expect(read.mock.calls).toEqual(items.map((item) => [[item.id], kind]));
        } finally {
          read.mockRestore();
        }
      });
    },
  );

  for (const { name, seed } of compositions) {
    test.each(rejectedCursors)(
      `${name}: $name курсор отклоняется до чтения владельца и состава`,
      async ({ stale, exitCode, errorCode }) => {
        await withCliFixture(async (cli) => {
          const project = cli.createProject();
          const { command } = cli.withDatabase(project, seed);
          const first = await cli.page([...command, "--limit", "1"], entityValue);
          let cursor = stringValue(first.meta.page.nextCursor);
          if (stale) {
            cli.withDatabase(project, (db) =>
              new TasksService(db).create({ title: "Новое поколение" }, "agent"),
            );
          } else {
            cursor += "x";
          }
          const get = spyOn(ProjectDatabase.prototype, "get");
          const getMany = spyOn(ProjectDatabase.prototype, "getMany");
          const identities = spyOn(ProjectDatabase.prototype, "getManyIdentities");
          try {
            const error = await cli.error([...command, "--cursor", cursor], exitCode);

            expect(error.code).toBe(errorCode);
            expect(get).not.toHaveBeenCalled();
            expect(getMany).not.toHaveBeenCalled();
            expect(identities).not.toHaveBeenCalled();
          } finally {
            get.mockRestore();
            getMany.mockRestore();
            identities.mockRestore();
          }
        });
      },
    );
  }
});
