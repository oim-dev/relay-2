import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import Ajv from "ajv";
import { HTTP_COMMAND_EXAMPLES, type BatchResult, type HttpBatchRequest } from "@relay/contracts";
import {
  BATCH_OPERATIONS,
  BatchService,
  CommandExecutor,
  KnowledgeService,
  TasksService,
} from "@relay/core";
import { ProjectDatabase } from "@relay/storage";
import { assertCommandSchemaCoverage, createCommandSchemas } from "../../scripts/command-schema";
import generatedSchemas from "../../src/http/generated-schemas.json";
import openapi from "../../openapi.json";

const definitions = createCommandSchemas(BATCH_OPERATIONS);
const ajv = new Ajv({ strict: false });
ajv.addSchema({ definitions }, "commands");
const validateBatch = ajv.compile({ $ref: "commands#/definitions/HttpBatchRequest" });
const validateCommand = ajv.compile({ $ref: "commands#/definitions/HttpCommandRequest" });
ajv.addSchema(generatedSchemas, "responses");
const validateResult = ajv.compile({
  $ref: "responses#/definitions/HttpApiSchemas/properties/batch",
});
ajv.addSchema({ components: openapi.components }, "wire");
const validateImplementation = ajv.compile({ $ref: "wire#/components/schemas/ImplementationData" });
const validateProjectEntity = ajv.compile({ $ref: "wire#/components/schemas/ProjectEntity" });
const validateCommandSuccess = ajv.compile({
  $ref: `wire${openapi.paths["/api/v2/projects/{projectId}/commands"].post.responses["200"].content["application/json"].schema.$ref}`,
});
const validateBatchSuccess = ajv.compile({
  $ref: `wire${openapi.paths["/api/v2/projects/{projectId}/batch"].post.responses["200"].content["application/json"].schema.$ref}`,
});
const write = { actor: "Разработчик", operationKey: "openapi" };
const minimalInputs: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  ...Object.fromEntries(
    [
      "project",
      "product",
      "feature",
      "scenario",
      "application",
      "implementation",
      "document",
      "board",
    ].map((kind) => [`${kind}.rename`, { key: "NEW-KEY" }]),
  ),
  "project.update": { name: "Проект" },
  "product.create": { name: "Продукт" },
  "product.update": { summary: "" },
  "feature.create": { name: "Фича" },
  "feature.update": { summary: "" },
  "scenario.create": { name: "Сценарий", featureId: "FEATURE-1" },
  "scenario.update": { summary: "" },
  "application.create": { name: "Приложение", slug: "app" },
  "application.update": { type: "internal" },
  "implementation.create": { title: "Реализация", applicationId: "APP-1", target: "FEATURE-1" },
  "implementation.update": { status: "none" },
  "document.create": { name: "Документ", body: "Текст" },
  "document.update": { sectionId: null },
  "application.participation.replace": { targets: [] },
  "document.section.create": { name: "Раздел" },
  "document.section.update": { id: "section", name: "Раздел" },
  "document.section.move": { id: "section", last: true },
  "document.section.remove": { id: "section" },
  "document.link": { target: "FEATURE-1" },
  "document.unlink": { target: "FEATURE-1" },
  "task.create": {},
  "task.update": { title: "" },
  "task.move": { column: "inbox" },
  "task.parent.set": { parent: "TASK-1" },
  "task.parent.clear": {},
  ...Object.fromEntries(
    ["task.dependency.add", "task.dependency.remove", "task.link", "task.unlink"].map((op) => [
      op,
      { target: "TASK-1" },
    ]),
  ),
  "task.criterion.add": { title: "Критерий" },
  "task.criterion.update": { criterionId: "criterion", summary: "" },
  ...Object.fromEntries(
    ["complete", "reopen", "remove"].map((action) => [
      `task.criterion.${action}`,
      { id: "criterion" },
    ]),
  ),
  "task.comment.add": { body: "Комментарий" },
  "plan.create": { title: "План" },
  "plan.update": { participants: [] },
  "plan.start": {},
  "plan.complete": { result: "Готово" },
  "plan.cancel": { result: "Отменено" },
  "release.create": { title: "Релиз", version: "1", planIds: ["PLN-1"] },
  "release.update": { plannedFor: "" },
  "release.plan": {},
  "release.publish": {},
  "release.cancel": {},
  "plan.stage.create": { title: "Этап" },
  "plan.stage.update": { stageId: "stage", summary: "" },
  "plan.stage.move": { stageId: "stage", before: null },
  "plan.stage.remove": { stageId: "stage" },
  "plan.stage.task.add": { stageId: "stage", task: "TASK-1" },
  "plan.stage.task.remove": { stageId: "stage", task: "TASK-1" },
  "plan.stage.task.transfer": {
    task: "TASK-1",
    targetPlan: "PLN-2",
    targetStage: "stage",
    reason: "Перенос",
    targetVersion: "version-token",
  },
  "session.start": { title: "Работа" },
  "session.fork": { title: "Дочерняя", runId: "run" },
  "session.attach": {},
  "session.resume": {},
  "session.takeover": { reason: "Передача" },
  "session.pause": { runId: "run", reason: "Пауза" },
  "session.complete": { runId: "run", result: "Готово" },
  "session.cancel": { result: "Отменено" },
  ...Object.fromEntries(
    ["open", "save", "complete", "cancel"].map((action) => [
      `checkpoint.${action}`,
      { runId: "run", title: "Материал", body: "Текст" },
    ]),
  ),
};
const invalidCommands = [
  {
    name: "перенос строки в конце заголовка задачи",
    command: { op: "task.create", input: { title: "Задача\n" } },
  },
  {
    name: "перенос строки в конце названия знания",
    command: { op: "feature.create", input: { name: "Фича\n" } },
  },
  {
    name: "перенос строки в конце заголовка истории",
    command: { op: "session.start", input: { title: "Сессия\n" } },
  },
  { name: "неизвестная операция", command: { op: "task.delete" } },
  { name: "числовой заголовок", command: { op: "task.create", input: { title: 5 } } },
  { name: "недопустимая колонка", command: { op: "task.create", input: { column: "deleted" } } },
  { name: "null вместо текста", command: { op: "task.create", input: { description: null } } },
  { name: "документ без body", command: { op: "document.create", input: { name: "Документ" } } },
  {
    name: "оба алиаса feature",
    command: { op: "scenario.create", input: { name: "Сценарий", feature: "F1", featureId: "F1" } },
  },
  { name: "сценарий без feature", command: { op: "scenario.create", input: { name: "Сценарий" } } },
  {
    name: "лишнее поле отношения",
    command: {
      op: "document.create",
      input: { name: "Документ", body: "Текст", relations: [{ target: "F1", extra: true }] },
    },
  },
  {
    name: "оба способа связей документа",
    command: {
      op: "document.create",
      input: { name: "Документ", body: "Текст", targets: [], relations: [] },
    },
  },
  {
    name: "$ref в теле",
    command: { op: "document.create", input: { name: "Документ", body: { $ref: "previous" } } },
  },
  {
    name: "$ref вместо целого scope",
    command: { op: "plan.create", input: { title: "План", scope: [{ $ref: "previous" }] } },
  },
  {
    name: "$ref в runId",
    command: {
      op: "session.pause",
      ref: "S1",
      ifRevision: 1,
      input: { runId: { $ref: "run" }, reason: "Пауза" },
    },
  },
  {
    name: "$revision в description",
    command: { op: "task.create", input: { description: { $revision: "previous" } } },
  },
  { name: "пустой update", command: { op: "task.update", ref: "T1", ifRevision: 1, input: {} } },
  { name: "нет ref", command: { op: "task.update", ifRevision: 1, input: { title: "Задача" } } },
  {
    name: "ref singleton",
    command: { op: "project.update", ref: "PROJECT", ifRevision: 1, input: { name: "Проект" } },
  },
  { name: "нет guards", command: { op: "task.update", ref: "T1", input: { title: "Задача" } } },
  {
    name: "дробная CAS",
    command: { op: "task.update", ref: "T1", ifRevision: 1.5, input: { title: "Задача" } },
  },
  {
    name: "пустой token",
    command: { op: "task.update", ref: "T1", expectedVersion: "", input: { title: "Задача" } },
  },
  {
    name: "guard независимого комментария",
    command: { op: "task.comment.add", ref: "T1", ifRevision: 1, input: { body: "Комментарий" } },
  },
  {
    name: "критерий без title",
    command: { op: "task.criterion.add", ref: "T1", ifRevision: 1, input: { summary: "Кратко" } },
  },
  {
    name: "criterion update без правки",
    command: { op: "task.criterion.update", ref: "T1", ifRevision: 1, input: { id: "criterion" } },
  },
  {
    name: "completed в новом критерии",
    command: {
      op: "task.create",
      input: { acceptanceCriteria: [{ title: "Критерий", completed: true }] },
    },
  },
  {
    name: "релиз с пустым составом",
    command: { op: "release.create", input: { title: "Релиз", version: "1", planIds: [] } },
  },
  {
    name: "нет guard цели переноса",
    command: {
      op: "plan.stage.task.transfer",
      ref: "P1",
      ifRevision: 1,
      input: { task: "T1", targetPlan: "P2", targetStage: "stage", reason: "Перенос" },
    },
  },
  {
    name: "null вместо даты",
    command: { op: "release.update", ref: "R1", ifRevision: 1, input: { plannedFor: null } },
  },
  {
    name: "null вместо client",
    command: { op: "session.start", input: { title: "Работа", client: null } },
  },
  {
    name: "operator без source",
    command: { op: "session.start", input: { title: "Работа", operator: { name: "Человек" } } },
  },
  {
    name: "complete без runId",
    command: { op: "session.complete", ref: "S1", ifRevision: 1, input: { result: "Готово" } },
  },
  {
    name: "acceptedSessionIds при open",
    command: {
      op: "checkpoint.open",
      ref: "S1",
      ifRevision: 1,
      input: { title: "Намерение", body: "Текст", runId: "run", acceptedSessionIds: [] },
    },
  },
];

/**
 * Владеет изолированной SQLite; закрывает соединение и убирает fixture при любом исходе.
 */
async function withCommandDatabase(
  action: (database: ProjectDatabase) => Promise<void>,
): Promise<void> {
  const parent = resolve(
    import.meta.dir,
    "../../../../.artifacts",
    new Date().toISOString().slice(0, 10),
    "server-web/openapi-commands/fixtures",
  );
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "schema-"));
  const database = ProjectDatabase.create(join(directory, "project.sqlite"), {
    id: crypto.randomUUID(),
    name: "OpenAPI",
    slug: "openapi",
  });
  try {
    await action(database);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Проверяет тот же запрос схемой и настоящим Core с сохранением квитанции и изменений.
 */
async function executeExample(
  database: ProjectDatabase,
  request: HttpBatchRequest,
): Promise<BatchResult> {
  expect(validateBatch(request), JSON.stringify(validateBatch.errors)).toBe(true);
  const { commands, ...options } = request;
  const result = await new BatchService(database).execute(
    { version: 1, operations: commands },
    options,
  );
  expect(validateResult({ ok: true, data: result }), JSON.stringify(validateResult.errors)).toBe(
    true,
  );
  return result;
}

describe("72 предметные команды внешнего контракта", () => {
  test("настоящие FI/SI сохраняют union ImplementationData в entity и успешных command/batch envelopes", async () => {
    await withCommandDatabase(async (database) => {
      const result = await executeExample(database, {
        ...write,
        commands: [
          { op: "feature.create", as: "feature", input: { name: "Поиск" } },
          {
            op: "scenario.create",
            as: "scenario",
            input: { name: "Поиск по названию", feature: { $ref: "feature" } },
          },
          {
            op: "application.create",
            as: "application",
            input: { name: "Клиент", slug: "client" },
          },
          {
            op: "implementation.create",
            as: "feature-implementation",
            ifRevision: { $revision: "application" },
            input: {
              title: "Поиск в клиенте",
              application: { $ref: "application" },
              target: { $ref: "feature" },
            },
          },
          {
            op: "implementation.create",
            ifRevision: { $revision: "feature-implementation" },
            input: {
              title: "Поиск по названию в клиенте",
              application: { $ref: "application" },
              target: { $ref: "scenario" },
            },
          },
        ],
      });
      const feature = result.entities.find(
        (entity) => entity.kind === "implementation" && entity.data.targetKind === "feature",
      );
      const scenario = result.entities.find(
        (entity) => entity.kind === "implementation" && entity.data.targetKind === "scenario",
      );
      if (
        feature?.kind !== "implementation" ||
        scenario?.kind !== "implementation" ||
        scenario.data.targetKind !== "scenario"
      ) {
        throw new Error("Core не создал обе ветви реализации");
      }
      const { scenarioId, ...scenarioWithoutId } = scenario.data;
      expect(feature.data).not.toHaveProperty("scenarioId");
      expect(feature.data.targetId).toBe(feature.data.featureId);
      expect(scenarioId).toBe(scenario.data.targetId);
      expect(scenario.data.featureId).toBe(feature.data.featureId);

      for (const implementation of [feature, scenario]) {
        const stored = new KnowledgeService(database).get("implementation", implementation.id);
        expect(stored).toEqual(implementation);
        expect(
          validateImplementation(stored.data),
          JSON.stringify(validateImplementation.errors),
        ).toBe(true);
        expect(validateProjectEntity(stored), JSON.stringify(validateProjectEntity.errors)).toBe(
          true,
        );
      }
      expect(
        validateCommandSuccess({ ok: true, data: result }),
        JSON.stringify(validateCommandSuccess.errors),
      ).toBe(true);
      expect(
        validateBatchSuccess({ ok: true, data: result }),
        JSON.stringify(validateBatchSuccess.errors),
      ).toBe(true);

      const invalidVariants = [
        {
          name: "feature с запрещённым scenarioId",
          entity: { ...feature, data: { ...feature.data, scenarioId } },
        },
        {
          name: "scenario без обязательного scenarioId",
          entity: { ...scenario, data: scenarioWithoutId },
        },
        {
          name: "scenario с null вместо ID",
          entity: { ...scenario, data: { ...scenario.data, scenarioId: null } },
        },
        {
          name: "неизвестный discriminator",
          entity: { ...scenario, data: { ...scenario.data, targetKind: "unknown" } },
        },
      ];
      for (const invalid of invalidVariants) {
        const malformed = {
          ...result,
          entities: result.entities.map((entity) =>
            entity.id === invalid.entity.id ? invalid.entity : entity,
          ),
        };
        expect(validateImplementation(invalid.entity.data), invalid.name).toBe(false);
        expect(validateProjectEntity(invalid.entity), invalid.name).toBe(false);
        expect(validateCommandSuccess({ ok: true, data: malformed }), invalid.name).toBe(false);
        expect(validateBatchSuccess({ ok: true, data: malformed }), invalid.name).toBe(false);
        expect(validateResult({ ok: true, data: malformed }), invalid.name).toBe(false);
      }
    });
  });

  test("каталог точен; новая операция или поле Core останавливают генерацию", () => {
    expect(Object.keys(minimalInputs).sort()).toEqual(
      BATCH_OPERATIONS.map((operation) => operation.op).sort(),
    );
    expect(definitions.HttpBatchCommand?.oneOf).toHaveLength(72);
    expect(definitions.HttpCommandRequest?.oneOf).toHaveLength(72);
    expect(() =>
      assertCommandSchemaCoverage([
        ...BATCH_OPERATIONS,
        {
          op: "future.create",
          description: "Новое",
          inputFields: [],
          referenceFields: [],
          ref: "none",
          revisionOwner: null,
        },
      ]),
    ).toThrow("Каталог OpenAPI");
    expect(() =>
      assertCommandSchemaCoverage(
        BATCH_OPERATIONS.map((operation) =>
          operation.op === "task.create"
            ? { ...operation, inputFields: [...operation.inputFields, "future"] }
            : operation,
        ),
      ),
    ).toThrow("Поля OpenAPI");
    expect(() =>
      createCommandSchemas(
        BATCH_OPERATIONS.map((operation) =>
          operation.op === "task.create"
            ? { ...operation, referenceFields: [...operation.referenceFields, "title.missing"] }
            : operation,
        ),
      ),
    ).toThrow("Нет пути локальной ссылки");
  });

  test.each(BATCH_OPERATIONS)(
    "$op принимает минимальный ввод и отвергает неизвестные поля",
    (operation) => {
      const command = {
        op: operation.op,
        input: minimalInputs[operation.op],
        ...(operation.ref === "required" ? { ref: "owner" } : {}),
        ...(operation.revisionOwner !== null ? { ifRevision: 1 } : {}),
      };

      expect(
        validateBatch({ ...write, commands: [command] }),
        JSON.stringify(validateBatch.errors),
      ).toBe(true);
      expect(
        validateCommand({ ...write, ...command }),
        JSON.stringify(validateCommand.errors),
      ).toBe(true);
      expect(
        validateBatch({
          ...write,
          commands: [{ ...command, input: { ...command.input, unexpected: true } }],
        }),
      ).toBe(false);
      expect(validateCommand({ ...write, ...command, unexpected: true })).toBe(false);
    },
  );

  test.each(invalidCommands)("неверная форма: $name", ({ command }) => {
    expect(validateBatch({ ...write, commands: [command] })).toBe(false);
  });

  test.each(Object.entries(HTTP_COMMAND_EXAMPLES))(
    "публикуемый пример %s принимается схемой и Core",
    async (family, request) => {
      await withCommandDatabase(async (database) => {
        const result = await executeExample(database, request);

        expect(result.status).toBe("committed");
        expect(new BatchService(database).getResult(request.operationKey).items).toEqual(
          result.items,
        );
        if (family === "knowledge") {
          const feature = result.entities.find((entity) => entity.kind === "feature");
          expect(result.entities.find((entity) => entity.kind === "scenario")?.data.featureId).toBe(
            feature?.id,
          );
          expect(
            result.entities.find((entity) => entity.kind === "document")?.data.relations,
          ).toMatchObject([{ target: { kind: "feature", id: feature?.id } }]);
        } else if (family === "tasks") {
          const task = result.entities.find((entity) => entity.kind === "task");
          expect(task?.data.acceptanceCriteria).toMatchObject([
            { title: "Находит по названию", completed: false },
          ]);
          expect(task?.data.comments).toMatchObject([{ body: "Начинаю работу" }]);
          expect(result.items[2]?.owner.revision).toBe(result.items[1]?.owner.revision);
        } else if (family === "planning") {
          const plan = result.entities.find((entity) => entity.kind === "work-plan");
          if (plan === undefined) {
            throw new Error("Нет плана");
          }
          expect(plan?.data.stages).toMatchObject([{ title: "Реализация" }]);
          expect(result.entities.find((entity) => entity.kind === "release")?.data.planIds).toEqual(
            [plan.id],
          );
        } else {
          expect(
            result.entities.find((entity) => entity.kind === "work-session")?.data.runs[0]
              ?.operator,
          ).toBeNull();
        }
      });
    },
  );

  test("task.create не требует title/board/input; defaults и parent:null совпадают с Core", async () => {
    await withCommandDatabase(async (database) => {
      expect(validateCommand({ ...write, op: "task.create" })).toBe(true);
      const result = await executeExample(database, {
        ...write,
        commands: [{ op: "task.create" }, { op: "task.create", input: { parent: null } }],
      });

      expect(
        result.entities
          .filter((entity) => entity.kind === "task")
          .map((task) => ({
            title: task.data.title,
            parent: task.data.parentId,
            column: task.data.column,
          })),
      ).toEqual([
        { title: "", parent: null, column: "inbox" },
        { title: "", parent: null, column: "inbox" },
      ]);
    });
  });

  test("вложенные relation.target.id, sectionId и scope.id принимают только разрешённые $ref", async () => {
    await withCommandDatabase(async (database) => {
      const project = new KnowledgeService(database).get("project", database.projectId);
      const result = await executeExample(database, {
        ...write,
        commands: [
          {
            op: "document.section.create",
            as: "section",
            ifRevision: project.revision,
            input: { name: "Правила" },
          },
          { op: "feature.create", as: "feature", input: { name: "Поиск" } },
          {
            op: "document.create",
            as: "document",
            input: {
              name: "Описание",
              body: "Текст",
              sectionId: { $ref: "section" },
              relations: [{ target: { kind: "feature", id: { $ref: "feature" } } }],
            },
          },
          {
            op: "document.update",
            ref: { $ref: "document" },
            ifRevision: { $revision: "document" },
            input: { sectionId: null },
          },
          {
            op: "plan.create",
            input: { title: "План", scope: [{ kind: "feature", id: { $ref: "feature" } }] },
          },
        ],
      });
      const document = result.entities.find((entity) => entity.kind === "document");
      const feature = result.entities.find((entity) => entity.kind === "feature");
      if (feature === undefined) {
        throw new Error("Нет фичи");
      }

      expect(document?.data.sectionId).toBeNull();
      expect(document?.data.relations).toMatchObject([
        { target: { kind: "feature", id: feature?.id } },
      ]);
      expect(result.entities.find((entity) => entity.kind === "work-plan")?.data.scope).toEqual([
        { kind: "feature", id: feature.id },
      ]);
    });
  });

  test("version-only допустим; при двух guards Core проверяет исходную локальную CAS", async () => {
    await withCommandDatabase(async (database) => {
      const executor = new CommandExecutor(database);
      const task = await new TasksService(database).create({ title: "Исходный" }, write.actor);
      const versioned = await executor.readVersioned(task.id, "task");
      const command = {
        op: "task.update",
        ref: task.id,
        expectedVersion: versioned.versions.aggregateVersion,
        input: { title: "Новый" },
      };
      expect(validateCommand({ ...write, ...command })).toBe(true);
      await executeExample(database, { ...write, commands: [command] });
      const fresh = await executor.readVersioned(task.id, "task");
      const stale = {
        ...command,
        expectedVersion: fresh.versions.aggregateVersion,
        ifRevision: task.revision,
        input: { title: "Не должен сохраниться" },
      };

      expect(validateBatch({ ...write, commands: [stale] })).toBe(true);
      await expect(
        executor.executeCommands([stale], { ...write, operationKey: "stale" }),
      ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
      expect(new TasksService(database).get(task.id).data.title).toBe("Новый");
    });
  });

  test("перенос принимает $revision двух владельцев и переносит единственное включение задачи", async () => {
    await withCommandDatabase(async (database) => {
      const result = await executeExample(database, {
        ...write,
        commands: [
          { op: "task.create", as: "task" },
          { op: "plan.create", as: "source", input: { title: "Исходный" } },
          {
            op: "plan.stage.create",
            as: "source-stage",
            ref: { $ref: "source" },
            ifRevision: { $revision: "source" },
            input: { title: "Первый" },
          },
          {
            op: "plan.stage.task.add",
            as: "added",
            ref: { $ref: "source" },
            ifRevision: { $revision: "source-stage" },
            input: { stageId: { $ref: "source-stage" }, task: { $ref: "task" } },
          },
          { op: "plan.create", as: "target", input: { title: "Целевой" } },
          {
            op: "plan.stage.create",
            as: "target-stage",
            ref: { $ref: "target" },
            ifRevision: { $revision: "target" },
            input: { title: "Второй" },
          },
          {
            op: "plan.stage.task.transfer",
            ref: { $ref: "source" },
            ifRevision: { $revision: "added" },
            input: {
              task: { $ref: "task" },
              targetPlan: { $ref: "target" },
              targetStage: { $ref: "target-stage" },
              targetRevision: { $revision: "target-stage" },
              reason: "Перенос",
            },
          },
        ],
      });
      const task = result.entities.find((entity) => entity.kind === "task");
      const plans = result.entities.filter((entity) => entity.kind === "work-plan");
      if (task === undefined) {
        throw new Error("Нет задачи");
      }

      expect(plans.find((plan) => plan.data.title === "Исходный")?.data.stages[0]?.taskIds).toEqual(
        [],
      );
      expect(plans.find((plan) => plan.data.title === "Целевой")?.data.stages[0]?.taskIds).toEqual([
        task.id,
      ]);
      expect(result.items[6]?.outputs[0]?.id).toBe(
        plans.find((plan) => plan.data.title === "Целевой")?.id,
      );
    });
  });

  test("схема не подменяет проверку авторизации $revision; Core откатывает комментарий вместе с отказом", async () => {
    await withCommandDatabase(async (database) => {
      const task = await new TasksService(database).create({ title: "Исходный" }, write.actor);
      const commands = [
        {
          op: "task.comment.add",
          as: "comment",
          ref: task.id,
          input: { body: "Не должен сохраниться" },
        },
        {
          op: "task.update",
          ref: task.id,
          ifRevision: { $revision: "comment" },
          input: { title: "Новый" },
        },
      ];

      expect(validateBatch({ ...write, commands })).toBe(true);
      await expect(
        new BatchService(database).execute({ version: 1, operations: commands }, write),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
        details: { path: "operations[1].ifRevision" },
      });
      expect(new TasksService(database).get(task.id)).toEqual(task);
    });
  });

  test("отмена paused-сессии не требует выдуманного runId", async () => {
    await withCommandDatabase(async (database) => {
      const started = await executeExample(database, HTTP_COMMAND_EXAMPLES.history);
      const session = started.entities.find((entity) => entity.kind === "work-session");
      if (session === undefined) {
        throw new Error("Не создана сессия");
      }
      const result = await executeExample(database, {
        ...write,
        commands: [
          {
            op: "session.pause",
            as: "paused",
            ref: session.id,
            ifRevision: session.revision,
            input: { runId: session.data.currentRunId, reason: "Пауза" },
          },
          {
            op: "session.cancel",
            ref: session.id,
            ifRevision: { $revision: "paused" },
            input: { result: "Отменено" },
          },
        ],
      });

      expect(result.entities.find((entity) => entity.kind === "work-session")?.data.status).toBe(
        "cancelled",
      );
    });
  });
});
