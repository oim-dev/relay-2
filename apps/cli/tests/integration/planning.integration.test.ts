import { expect, test } from "bun:test";
import { PlanningService, TasksService, type ProjectDatabase } from "@relay/core";
import { withCliFixture } from "./helpers/cli-fixture";
import { arrayValue, entityValue, objectValue, stringValue } from "./helpers/responses";

function stageValue(value: unknown) {
  const stage = objectValue(value);
  return {
    id: stringValue(stage.id),
    title: stringValue(stage.title),
    taskIds: arrayValue(stage.taskIds).map(stringValue),
  };
}

function stagedPlan(db: ProjectDatabase) {
  const planning = new PlanningService(db);
  const created = planning.create("work-plan", { title: "План" }, "agent");
  const plan = planning.stage(
    created.id,
    "create",
    { title: "Этап" },
    {
      actor: "agent",
      ifRevision: created.revision,
    },
  );
  return { plan, stage: stageValue(arrayValue(plan.data.stages)[0]) };
}

test("CLI передаёт status в Core: допустимый фильтр выбирает план, неверный возвращает INVALID_ARGUMENT", async () => {
  await withCliFixture(async (cli) => {
    const project = cli.createProject();
    const plan = cli.withDatabase(project, (db) => {
      const planning = new PlanningService(db);
      const draft = planning.create("work-plan", { title: "Черновик" }, "agent");
      const cancelled = planning.create("work-plan", { title: "История" }, "agent");
      planning.transition(
        "work-plan",
        cancelled.id,
        "cancel",
        { result: "Закрыто" },
        { actor: "agent", ifRevision: cancelled.revision },
      );
      return draft;
    });
    const page = await cli.page(["plan", "list", "--status", "draft"], entityValue);
    expect(page.data.items).toEqual([plan]);
    expect((await cli.error(["plan", "list", "--status", "banana"], 2)).code).toBe(
      "INVALID_ARGUMENT",
    );
  });
});

test.each([
  { name: "stages", stages: null, command: ["plan", "stage", "list"], tail: [] },
  {
    name: "taskIds",
    stages: [{ id: "stage", taskIds: null }],
    command: ["plan", "stage", "task", "list"],
    tail: ["stage"],
  },
])(
  "повреждённый $name возвращает CORRUPT_DATA без изменения поколения",
  async ({ stages, command, tail }) => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const { plan, generation } = cli.withDatabase(project, (db) => {
        const plan = new PlanningService(db).create(
          "work-plan",
          { title: "Повреждённый" },
          "agent",
        );
        db.update(
          { ...plan, revision: plan.revision + 1, data: { ...plan.data, stages } },
          plan.revision,
        );
        return { plan, generation: db.getGeneration() };
      });
      const error = await cli.error([...command, plan.key, ...tail], 1);
      expect(error.code).toBe("CORRUPT_DATA");
      expect(cli.withDatabase(project, (db) => db.getGeneration())).toBe(generation);
    });
  },
);

test("JSON stageId не подменяет позиционный этап и не изменяет план", async () => {
  await withCliFixture(async (cli) => {
    const project = cli.createProject();
    const { plan, stage } = cli.withDatabase(project, stagedPlan);
    const error = await cli.error(
      [
        "plan",
        "stage",
        "update",
        plan.key,
        stage.id,
        "--input",
        JSON.stringify({ stageId: "ignored", title: "Не сохранять" }),
        "--if-revision",
        String(plan.revision),
      ],
      2,
    );
    expect(error.code).toBe("INVALID_ARGUMENT");
    expect(await cli.entity(["plan", "get", plan.key])).toEqual(plan);
  });
});

test("созданный CLI этап читается в составе плана", async () => {
  await withCliFixture(async (cli) => {
    const project = cli.createProject();
    const plan = cli.withDatabase(project, (db) =>
      new PlanningService(db).create("work-plan", { title: "План" }, "agent"),
    );
    const updated = await cli.entity([
      "plan",
      "stage",
      "create",
      plan.key,
      "--title",
      "Этап",
      "--if-revision",
      String(plan.revision),
    ]);
    const stages = arrayValue(updated.data.stages).map(stageValue);
    expect(stages).toHaveLength(1);
    expect(stages[0]).toMatchObject({ title: "Этап", taskIds: [] });
    expect(updated.revision).toBe(plan.revision + 1);
    const page = await cli.page(["plan", "stage", "list", plan.key], stageValue);
    expect(page.data.items).toEqual(stages);
    expect(page.meta.page.total).toBe(1);
  });
});

test("включение задачи по ключу сохраняет её ID в указанном этапе", async () => {
  await withCliFixture(async (cli) => {
    const project = cli.createProject();
    const { plan, stage, task } = cli.withDatabase(project, (db) => ({
      ...stagedPlan(db),
      task: new TasksService(db).create({ title: "Работа" }, "agent"),
    }));
    const updated = await cli.entity([
      "plan",
      "stage",
      "task",
      "add",
      plan.key,
      stage.id,
      task.key,
      "--if-revision",
      String(plan.revision),
    ]);
    expect(arrayValue(updated.data.stages).map(stageValue)).toEqual([
      { ...stage, taskIds: [task.id] },
    ]);
    const page = await cli.page(["plan", "stage", "task", "list", plan.key, stage.id], entityValue);
    expect(page.data.items).toEqual([task]);
  });
});

test("страница включений задачи указывает план и этап", async () => {
  await withCliFixture(async (cli) => {
    const project = cli.createProject();
    const { plan, stage, task } = cli.withDatabase(project, (db) => {
      const { plan, stage } = stagedPlan(db);
      const task = new TasksService(db).create({ title: "Работа" }, "agent");
      const included = new PlanningService(db).stageTask(plan.id, stage.id, task.id, false, {
        actor: "agent",
        ifRevision: plan.revision,
      });
      return { plan: included, stage, task };
    });
    const page = await cli.page(["plan", "task", "memberships", task.key], (value) => {
      const item = objectValue(value);
      return { plan: stringValue(item.plan), stage: stageValue(item.stage) };
    });
    expect(page.data.items).toEqual([{ plan: plan.key, stage: { ...stage, taskIds: [task.id] } }]);
    expect(page.meta.page).toMatchObject({ count: 1, total: 1 });
  });
});

test("флаги создания релиза сохраняют версию и читаемый состав планов", async () => {
  await withCliFixture(async (cli) => {
    const project = cli.createProject();
    const plan = cli.withDatabase(project, (db) =>
      new PlanningService(db).create("work-plan", { title: "План" }, "agent"),
    );
    const release = await cli.entity([
      "release",
      "create",
      "--title",
      "Выпуск",
      "--release-version",
      "1.0.0",
      "--plans",
      plan.key,
    ]);
    expect(release.data).toMatchObject({ version: "1.0.0", planIds: [plan.id] });
    const page = await cli.page(["release", "plans", release.key], entityValue);
    expect(page.data.items).toEqual([plan]);
    expect(page.meta.page).toMatchObject({ count: 1, total: 1 });
  });
});

test("JSON обновления релиза принимает канонические version и planIds", async () => {
  await withCliFixture(async (cli) => {
    const project = cli.createProject();
    const { release, replacement } = cli.withDatabase(project, (db) => {
      const planning = new PlanningService(db);
      const original = planning.create("work-plan", { title: "Исходный" }, "agent");
      const replacement = planning.create("work-plan", { title: "Новый" }, "agent");
      const release = planning.create(
        "release",
        {
          title: "Выпуск",
          version: "1.0.0",
          planIds: [original.id],
        },
        "agent",
      );
      return { release, replacement };
    });
    const updated = await cli.entity([
      "release",
      "update",
      release.key,
      "--input",
      JSON.stringify({ version: "1.0.1", planIds: [replacement.key] }),
      "--if-revision",
      String(release.revision),
    ]);
    expect(updated.data).toMatchObject({ version: "1.0.1", planIds: [replacement.id] });
    expect(await cli.entity(["release", "get", release.key])).toEqual(updated);
  });
});

test("публикация подготовленного релиза сохраняет released", async () => {
  await withCliFixture(async (cli) => {
    const project = cli.createProject();
    const release = cli.withDatabase(project, (db) => {
      const planning = new PlanningService(db);
      const { plan, stage } = stagedPlan(db);
      const task = new TasksService(db).create({ title: "Выполнено", column: "done" }, "agent");
      const included = planning.stageTask(plan.id, stage.id, task.id, false, {
        actor: "agent",
        ifRevision: plan.revision,
      });
      const completed = planning.transition(
        "work-plan",
        plan.id,
        "complete",
        { result: "Готово" },
        {
          actor: "agent",
          ifRevision: included.revision,
        },
      );
      return planning.create(
        "release",
        { title: "Выпуск", version: "1.0.0", planIds: [completed.id] },
        "agent",
      );
    });
    const published = await cli.entity([
      "release",
      "publish",
      release.key,
      "--if-revision",
      String(release.revision),
    ]);
    expect(published.data).toMatchObject({ status: "released", releasedBy: "agent" });
    expect(await cli.entity(["release", "get", release.key])).toEqual(published);
  });
});
