import { describe, expect, spyOn, test } from "bun:test";
import type { PlanningCompositionPageRequest, WorkPlanRecord } from "@relay/contracts";
import { ProjectDatabase } from "@relay/storage";
import { PlanningService } from "../../src/planning/planning";
import { TasksService } from "../../src/tasks/tasks";
import {
  entityWriteOptions as write,
  expectRelayError,
  withEntityDatabase,
} from "./helpers/entity-fixture";
import type {
  PlanningPageFixture,
  PlanningPageOwner,
  PlanningPageResult,
} from "./helpers/planning-fixture.types";

const compositions = [
  { name: "этап", kind: "task", seed: seedStageTasks },
  { name: "релиз", kind: "work-plan", seed: seedReleasePlans },
] as const;

const brokenReferences = [
  { name: "отсутствующий ID в окне", index: 0, reference: "missing" },
  { name: "отсутствующий ID вне окна", index: 2, reference: "missing" },
  { name: "чужой вид вне окна", index: 2, reference: "wrong-kind" },
  { name: "ключ вместо постоянного ID вне окна", index: 2, reference: "key" },
] as const;

const invalidWindows = [
  { name: "отрицательное смещение", request: { offset: -1, limit: 1 } },
  { name: "нулевой лимит", request: { offset: 0, limit: 0 } },
] as const;

/**
 * Возвращает ID единственного этапа; неполная подготовка немедленно завершает тест.
 */
function stageId(plan: WorkPlanRecord): string {
  const stage = plan.data.stages[0];
  if (!stage) {
    throw new Error("Для проверки страницы нужен этап");
  }
  return stage.id;
}

/**
 * Создаёт три задачи с полными текстами и комментариями и включает их в порядке 3, 2, 1.
 * Соединением владеет вызывающий fixture; подготовка завершена до перехватов чтения.
 */
function seedStageTasks(db: ProjectDatabase): PlanningPageFixture {
  const tasks = new TasksService(db);
  const records = ["Первая", "Вторая", "Третья"].map((title) => {
    const task = tasks.create({ title, description: `# ${title}\n\nПолное описание\n` }, "tester");
    return tasks.comment(task.id, `Комментарий: ${title}`, "tester");
  });
  const items = records.toReversed();
  const service = new PlanningService(db);
  let owner = service.create("work-plan", { title: "Владелец этапа" }, "tester");
  owner = service.stage(owner.id, "create", { title: "Этап" }, write(owner));
  for (const task of items) {
    owner = service.stageTask(owner.id, stageId(owner), task.id, false, write(owner));
  }
  return { owner, items };
}

/**
 * Создаёт три плана с полными текстами и включает их в релиз в порядке 3, 2, 1.
 * Соединение остаётся во владении вызывающего fixture.
 */
function seedReleasePlans(db: ProjectDatabase): PlanningPageFixture {
  const service = new PlanningService(db);
  const records = ["Первый", "Второй", "Третий"].map((title) =>
    service.create("work-plan", { title, goal: `# ${title}\n\nПолная цель\n` }, "tester"),
  );
  const items = records.toReversed();
  const owner = service.create(
    "release",
    { title: "Владелец релиза", version: "1", planIds: items.map((item) => item.id) },
    "tester",
  );
  return { owner, items };
}

/**
 * Вызывает публичное чтение страницы соответствующего владельца без дополнительного чтения БД.
 */
function readPage(
  db: ProjectDatabase,
  fixture: PlanningPageFixture,
  request: Readonly<PlanningCompositionPageRequest>,
): PlanningPageResult {
  const service = new PlanningService(db);
  return fixture.owner.kind === "work-plan"
    ? service.stageTasksPage(fixture.owner.key, stageId(fixture.owner), request)
    : service.releasePlansPage(fixture.owner.key, request);
}

/**
 * Выбирает явно ожидаемые метаданные владельца без вызова проверяемого сценария.
 */
function ownerMetadata(owner: PlanningPageFixture["owner"]): PlanningPageOwner {
  return owner.kind === "work-plan"
    ? { plan: owner.key, revision: owner.revision }
    : { release: owner.key, revision: owner.revision };
}

/**
 * Намеренно заменяет сохранённые ID в обход Core для проверки повреждённых ссылок.
 */
function corruptReferences(
  db: ProjectDatabase,
  owner: PlanningPageFixture["owner"],
  ids: readonly string[],
): void {
  const data =
    owner.kind === "work-plan"
      ? {
          ...owner.data,
          stages: owner.data.stages.map((stage) => ({ ...stage, taskIds: [...ids] })),
        }
      : { ...owner.data, planIds: [...ids] };
  db.update({ ...owner, revision: owner.revision + 1, data }, owner.revision);
}

/**
 * Требует карточку в минимальном подготовленном составе вместо молчаливого пропуска.
 */
function itemAt(fixture: PlanningPageFixture, index: number): PlanningPageFixture["items"][number] {
  const item = fixture.items[index];
  if (!item) {
    throw new Error(`В составе отсутствует карточка ${index}`);
  }
  return item;
}

describe("Ограниченные страницы составов планирования", () => {
  test.each(compositions)(
    "$name: страницы сохраняют порядок, total, владельца и читают только карточки окна",
    ({ seed, kind }) => {
      withEntityDatabase((db) => {
        const fixture = seed(db);
        const get = spyOn(db, "get");
        const getMany = spyOn(db, "getMany");
        const list = spyOn(db, "list");
        try {
          const first = readPage(db, fixture, { offset: 0, limit: 2 });
          const last = readPage(db, fixture, { offset: 2, limit: 2 });
          const empty = readPage(db, fixture, { offset: 3, limit: 2 });

          const owner = ownerMetadata(fixture.owner);
          expect(first).toEqual({
            ...owner,
            total: 3,
            items: [itemAt(fixture, 0), itemAt(fixture, 1)],
          });
          expect(last).toEqual({ ...owner, total: 3, items: [itemAt(fixture, 2)] });
          expect(empty).toEqual({ ...owner, total: 3, items: [] });
          expect(get.mock.calls).toEqual(
            Array.from({ length: 3 }, () => [fixture.owner.id, fixture.owner.kind]),
          );
          expect(getMany.mock.calls).toEqual([
            [[itemAt(fixture, 0).id, itemAt(fixture, 1).id], kind],
            [[itemAt(fixture, 2).id], kind],
            [[], kind],
          ]);
          expect(list).not.toHaveBeenCalled();
        } finally {
          get.mockRestore();
          getMany.mockRestore();
          list.mockRestore();
        }
      });
    },
  );

  test("пустой этап возвращает владельца и нулевой total", () => {
    withEntityDatabase((db) => {
      const service = new PlanningService(db);
      const initial = service.create("work-plan", { title: "Пустой план" }, "tester");
      const plan = service.stage(initial.id, "create", { title: "Этап" }, write(initial));

      const page = service.stageTasksPage(plan.key, stageId(plan), { offset: 0, limit: 1 });

      expect(page).toEqual({ plan: plan.key, revision: plan.revision, items: [], total: 0 });
    });
  });

  test("страница отсутствующего этапа возвращает NOT_FOUND", () => {
    withEntityDatabase((db) => {
      const service = new PlanningService(db);
      const plan = service.create("work-plan", { title: "План без этапов" }, "tester");

      const error = expectRelayError(
        () => service.stageTasksPage(plan.key, "missing-stage", { offset: 0, limit: 1 }),
        "NOT_FOUND",
      );

      expect(error.details).toMatchObject({ stageId: "missing-stage" });
    });
  });

  test.each(compositions)(
    "$name: владелец, total и карточка окна принадлежат одному снимку при записи другого соединения",
    ({ seed }) => {
      withEntityDatabase((db) => {
        const fixture = seed(db);
        const { owner } = fixture;
        const selected = itemAt(fixture, 0);
        const removed = itemAt(fixture, 2);
        const writer = ProjectDatabase.open(db.path);
        /**
         * Сохраняет настоящий SQLite-reader до перехвата, исключая рекурсивный вызов spy.
         */
        const originalGet: ProjectDatabase["get"] = db.get.bind(db);
        let changed = false;
        const get = spyOn(db, "get").mockImplementation((ref, kind) => {
          const record = originalGet(ref, kind);
          if (record?.id === owner.id && !changed) {
            changed = true;
            writer.transaction(() => {
              const service = new PlanningService(writer);
              if (owner.kind === "work-plan") {
                service.stageTask(owner.id, stageId(owner), removed.id, true, write(owner));
                new TasksService(writer).update(
                  selected.id,
                  { description: "После записи" },
                  write(selected),
                );
              } else {
                service.update(
                  "release",
                  owner.id,
                  { planIds: [selected.id, itemAt(fixture, 1).id] },
                  write(owner),
                );
                service.update("work-plan", selected.id, { goal: "После записи" }, write(selected));
              }
            });
          }
          return record;
        });
        try {
          const page = readPage(db, fixture, { offset: 0, limit: 1 });

          expect(page).toEqual({ ...ownerMetadata(owner), total: 3, items: [selected] });
          expect(changed).toBe(true);
        } finally {
          get.mockRestore();
          writer.close();
        }
        const current = readPage(db, fixture, { offset: 0, limit: 1 });
        expect(current.revision).toBe(owner.revision + 1);
        expect(current.total).toBe(2);
        expect(current.items[0]?.data).toMatchObject(
          owner.kind === "work-plan" ? { description: "После записи" } : { goal: "После записи" },
        );
      });
    },
  );

  for (const { name, seed, kind } of compositions) {
    test.each(brokenReferences)(
      `${name}: $name не скрывается ограничением окна`,
      ({ index, reference }) => {
        withEntityDatabase((db) => {
          const fixture = seed(db);
          const ids = fixture.items.map((item) => item.id);
          let broken = "missing-id";
          if (reference === "wrong-kind") {
            broken = db.projectId;
          } else if (reference === "key") {
            broken = itemAt(fixture, index).key;
          }
          ids[index] = broken;
          corruptReferences(db, fixture.owner, ids);

          const error = expectRelayError(
            () => readPage(db, fixture, { offset: 0, limit: 1 }),
            "NOT_FOUND",
          );

          expect(error.details).toEqual({ ref: broken, kind });
        });
      },
    );

    test.each(invalidWindows)(`${name}: $name отклоняется до чтения владельца`, ({ request }) => {
      withEntityDatabase((db) => {
        const fixture = seed(db);
        const get = spyOn(db, "get");
        try {
          expectRelayError(() => readPage(db, fixture, request), "INVALID_ARGUMENT");

          expect(get).not.toHaveBeenCalled();
        } finally {
          get.mockRestore();
        }
      });
    });
  }

  test.each(compositions)(
    "$name: повреждённая карточка окна возвращает CORRUPT_DATA",
    ({ seed }) => {
      withEntityDatabase((db) => {
        const fixture = seed(db);
        const selected = itemAt(fixture, 0);
        // Повреждаем обязательный текст выбранной карточки в обход предметного декодера.
        const data =
          selected.kind === "task"
            ? { ...selected.data, description: null }
            : { ...selected.data, goal: null };
        db.update({ ...selected, revision: selected.revision + 1, data }, selected.revision);

        const error = expectRelayError(
          () => readPage(db, fixture, { offset: 0, limit: 1 }),
          "CORRUPT_DATA",
        );

        expect(error.details).toMatchObject({ id: selected.id });
      });
    },
  );
});
