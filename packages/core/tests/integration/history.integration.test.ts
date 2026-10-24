import { describe, expect, test } from "bun:test";
import type { WriteOptions } from "@relay/contracts";
import { CommandExecutor } from "../../src/batch/batch";
import { HistoryService } from "../../src/history/history";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { TasksService } from "../../src/tasks/tasks";
import {
  completeHistorySession,
  corruptHistoryRuns,
  currentHistoryRun,
  expectHistoryError,
  forkHistorySession,
  historyOwner,
  insertCorruptedHistoryCheckpoint,
  openHistoryIntent,
  recordHistoryMaterial,
  snapshotHistoryStorage,
  withHistoryFixture,
  withHistorySessionUpdateFailure,
} from "./history-fixture";
import type { HistoryInputCase } from "./history-fixture.types";

const invalidStartCases = [
  { name: "null вместо поручения отклоняется без создания сессии", input: null },
  { name: "массив вместо поручения отклоняется без создания сессии", input: [] },
  { name: "строка вместо поручения отклоняется без создания сессии", input: "поручение" },
  { name: "отсутствующий заголовок отклоняется без создания сессии", input: {} },
  { name: "пробельный заголовок отклоняется без создания сессии", input: { title: "  " } },
  {
    name: "многострочный заголовок отклоняется без создания сессии",
    input: { title: "Первая\nВторая" },
  },
  {
    name: "неизвестное поле поручения отклоняется без создания сессии",
    input: { title: "Поручение", extra: true },
  },
  {
    name: "числовое имя оператора отклоняется без создания сессии",
    input: { title: "Поручение", operator: { name: 1, source: "explicit" } },
  },
] as const satisfies readonly HistoryInputCase[];

const invalidCheckpointCases = [
  { name: "пробельный текст материала отклоняется без записи", input: { body: "\n \t" } },
  { name: "числовой заголовок материала отклоняется без записи", input: { title: 42 } },
  { name: "число вместо ссылки материала отклоняется без записи", input: { references: [42] } },
  {
    name: "пропуск элемента в ссылках материала отклоняется без записи",
    input: { references: new Array<unknown>(1) },
  },
  { name: "неизвестное поле материала отклоняется без записи", input: { unknown: true } },
  {
    name: "поле приёмки в новом намерении отклоняется даже с пустым массивом",
    input: { acceptedSessionIds: [] },
  },
] as const satisfies readonly HistoryInputCase<Readonly<Record<string, unknown>>>[];

const invalidRevisionCases = [
  { name: "нулевая ревизия отклоняется без записи материала", input: 0 },
  { name: "отрицательная ревизия отклоняется без записи материала", input: -1 },
  { name: "дробная ревизия отклоняется без записи материала", input: 1.5 },
  { name: "NaN вместо ревизии отклоняется без записи материала", input: NaN },
  { name: "бесконечная ревизия отклоняется без записи материала", input: Infinity },
  { name: "строковая ревизия отклоняется без записи материала", input: "1" },
] as const satisfies readonly HistoryInputCase[];

const corruptedDocumentNames = [
  { name: "имя документа null блокирует снимок без изменения истории", input: null },
  { name: "отсутствующее имя документа блокирует снимок без изменения истории", input: undefined },
] as const satisfies readonly HistoryInputCase[];

const rejectedRunReferences = [
  { name: "ID прежнего участия со свежей ревизией отклоняется без записи", form: "previousId" },
  { name: "ключ текущего участия вместо ID отклоняется без записи", form: "currentKey" },
] as const;

const blockedChildClosures = [
  { name: "незавершённый ребёнок запрещает завершить исходное намерение", action: "complete" },
  { name: "незавершённый ребёнок запрещает отменить исходное намерение", action: "cancel" },
] as const;

const rejectedAcceptanceReferences = [
  { name: "ключ завершённого ребёнка отклоняется при приёмке без записи", form: "key" },
  {
    name: "типизированный адрес завершённого ребёнка отклоняется при приёмке без записи",
    form: "typedId",
  },
] as const;

const closedIntentActions = [
  { name: "сохранение продолжения закрытого намерения отклоняется без записи", action: "save" },
  { name: "повторное завершение намерения отклоняется без записи", action: "complete" },
  { name: "отмена завершённого намерения отклоняется без записи", action: "cancel" },
] as const;

const acceptingClosureCases = [
  {
    name: "приёмка в материале завершения закрывает намерение и разрешает завершить сессию",
    action: "complete",
    expectedKind: "result",
  },
  {
    name: "приёмка в материале отмены закрывает намерение и разрешает завершить сессию",
    action: "cancel",
    expectedKind: "cancel",
  },
] as const;

const materialBody = "\n## Основания\r\n\r\n```ts\r\n  const вывод = true;\r\n```\r\n\n";

describe("Снимки ссылок в материалах истории", () => {
  test.each(corruptedDocumentNames)("$name", async ({ input }) => {
    await withHistoryFixture(async (history, { db }) => {
      const document = await new KnowledgeService(db).create(
        "document",
        { name: "Исходное имя", body: "Текст" },
        "автор",
      );
      const session = await history.start({ title: "Проверить документ" }, "агент");
      const corruptedData: Record<string, unknown> = { ...document.data };
      // Намеренно портим обязательное имя через Storage: ключ не должен скрыть потерю содержания.
      if (input === undefined) {
        delete corruptedData.name;
      } else {
        corruptedData.name = input;
      }
      const corrupted = { ...document, revision: document.revision + 1, data: corruptedData };
      db.update(corrupted, document.revision);
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(
        async () =>
          await history.checkpoint(
            session.id,
            "open",
            {
              title: "Прочитать документ",
              body: "Сохранить основание работы",
              runId: session.data.currentRunId,
              references: [document.key],
            },
            historyOwner(session),
          ),
        "CORRUPT_DATA",
      );

      expect(snapshotHistoryStorage(db)).toEqual(before);
      expect(db.get(document.id)).toEqual(corrupted);
    });
  });

  test("пустой паспорт продукта сохраняет ключ как название снимка", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const product = new KnowledgeService(db).get("product");
      const session = await history.start({ title: "Начать работу над продуктом" }, "агент");

      const checkpoint = await history.checkpoint(
        session.id,
        "open",
        {
          title: "Определить содержание продукта",
          body: "Паспорт ещё не заполнен",
          runId: session.data.currentRunId,
          references: [product.key],
        },
        historyOwner(session),
      );

      expect(checkpoint.data.references).toEqual([
        { id: product.id, kind: "product", key: product.key, title: product.key },
      ]);
    });
  });

  test("пустой заголовок задачи сохраняется в снимке без подмены ключом", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const task = await new TasksService(db).create({}, "автор");
      const session = await history.start({ title: "Начать работу над задачей" }, "агент");

      const checkpoint = await history.checkpoint(
        session.id,
        "open",
        {
          title: "Определить содержание задачи",
          body: "Задача ещё не заполнена",
          runId: session.data.currentRunId,
          references: [task.key],
        },
        historyOwner(session),
      );

      expect(checkpoint.data.references).toEqual([
        { id: task.id, kind: "task", key: task.key, title: "" },
      ]);
    });
  });

  test("виртуальные типизированные ссылки сохраняют реальные ID и виды целей", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const knowledge = new KnowledgeService(db);
      const application = await knowledge.create(
        "application",
        { name: "Веб-клиент", slug: "web", prefix: "WEB" },
        "автор",
      );
      const board = knowledge.get("board", "board:product");
      const session = await history.start({ title: "Ссылки из материала" }, "агент");

      const intent = await history.checkpoint(
        `work-session:${session.id}`,
        "open",
        {
          title: "Проверить приложение",
          body: "Сохранить основания.",
          runId: session.data.currentRunId,
          references: ["board:product", "application:web"],
        },
        historyOwner(session),
      );

      expect(intent.data.references).toEqual([
        { id: board.id, kind: "board", key: board.key, title: board.data.name },
        { id: application.id, kind: "application", key: application.key, title: "Веб-клиент" },
      ]);
    });
  });

  test("адрес материала вместо адреса сессии отклоняется при чтении сессии", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const session = await history.start({ title: "Типизированное чтение сессии" }, "агент");
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(
        async () => history.get(`work-checkpoint:${session.id}`),
        "INVALID_ARGUMENT",
      );

      expect(snapshotHistoryStorage(db)).toEqual(before);
    });
  });

  test("адрес сессии вместо адреса материала отклоняется при чтении материала", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const session = await history.start({ title: "Типизированное чтение материала" }, "агент");
      const intent = await openHistoryIntent(history, session);
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(
        async () => history.getCheckpoint(`work-session:${intent.id}`),
        "INVALID_ARGUMENT",
      );

      expect(snapshotHistoryStorage(db)).toEqual(before);
    });
  });

  test("ссылка с неверным видом существующей цели отклоняется без записи материала", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const application = await new KnowledgeService(db).create(
        "application",
        { name: "Веб-клиент", slug: "web", prefix: "WEB" },
        "автор",
      );
      const session = await history.start({ title: "Проверить вид ссылки" }, "агент");
      const intent = await openHistoryIntent(history, session);
      const current = history.get(session.id);
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(
        async () =>
          await recordHistoryMaterial(history, current, intent, "save", {
            references: [`task:${application.id}`],
          }),
        "NOT_FOUND",
      );

      expect(snapshotHistoryStorage(db)).toEqual(before);
    });
  });

  test("два адреса одной цели отклоняются как дубликат без записи материала", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const board = new KnowledgeService(db).get("board", "board:product");
      const session = await history.start({ title: "Проверить уникальность ссылок" }, "агент");
      const intent = await openHistoryIntent(history, session);
      const current = history.get(session.id);
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(
        async () =>
          await recordHistoryMaterial(history, current, intent, "save", {
            references: ["board:product", `board:${board.id}`],
          }),
        "INVALID_INPUT",
      );

      expect(snapshotHistoryStorage(db)).toEqual(before);
    });
  });

  test("постороннее поле name задачи не подменяет проверенный заголовок в снимке", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const task = await new TasksService(db).create({ title: "Проверенный заголовок" }, "автор");
      // Внедряем чужое поле через Storage: оно не является названием задачи.
      db.update(
        { ...task, revision: task.revision + 1, data: { ...task.data, name: null } },
        task.revision,
      );
      const session = await history.start({ title: "Проверить задачу" }, "агент");

      const checkpoint = await history.checkpoint(
        session.id,
        "open",
        {
          title: "Исследовать задачу",
          body: "Сохранить корректное название цели",
          runId: session.data.currentRunId,
          references: [task.id],
        },
        historyOwner(session),
      );

      expect(checkpoint.data.references).toEqual([
        { id: task.id, kind: "task", key: task.key, title: "Проверенный заголовок" },
      ]);
      expect(history.getCheckpoint(checkpoint.id)).toEqual(checkpoint);
      expect(history.history(session.id)).toEqual([checkpoint]);
    });
  });
});

describe("Проверка внешнего ввода истории", () => {
  test.each(invalidStartCases)("$name", async ({ input }) => {
    await withHistoryFixture(async (history, { db }) => {
      const invalidInput = structuredClone(input);
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(
        async () => await history.start(invalidInput, "агент"),
        "INVALID_INPUT",
      );

      expect(snapshotHistoryStorage(db)).toEqual(before);
    });
  });

  test.each(invalidCheckpointCases)("$name", async ({ input }) => {
    await withHistoryFixture(async (history, { db }) => {
      const session = await history.start({ title: "Проверка ввода материала" }, "агент");
      const invalidInput = {
        title: "Проверить вход",
        body: "Содержательный материал.",
        runId: session.data.currentRunId,
        ...structuredClone(input),
      };
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(
        async () =>
          await history.checkpoint(session.id, "open", invalidInput, historyOwner(session)),
        "INVALID_INPUT",
      );

      expect(snapshotHistoryStorage(db)).toEqual(before);
    });
  });

  test.each(invalidRevisionCases)("$name", async ({ input }) => {
    await withHistoryFixture(async (history, { db }) => {
      const session = await history.start({ title: "Проверка ввода ревизии" }, "агент");
      const invalidOptions = { actor: "агент", ifRevision: input };
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(
        async () =>
          await history.checkpoint(
            session.id,
            "open",
            {
              title: "Проверить ревизию",
              body: "Не записывать материал с неверной ревизией.",
              runId: session.data.currentRunId,
            },
            // Намеренно нарушаем статический контракт для проверки внешней границы сервиса.
            invalidOptions as WriteOptions,
          ),
        "INVALID_INPUT",
      );

      expect(snapshotHistoryStorage(db)).toEqual(before);
    });
  });

  test("несуществующая цель отклоняется без записи материала и изменения сессии", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const session = await history.start({ title: "Проверка отсутствующей цели" }, "агент");
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(
        async () =>
          await history.checkpoint(
            session.id,
            "open",
            {
              title: "Прочитать цель",
              body: "Цель должна существовать.",
              runId: session.data.currentRunId,
              references: [crypto.randomUUID()],
            },
            historyOwner(session),
          ),
        "NOT_FOUND",
      );

      expect(snapshotHistoryStorage(db)).toEqual(before);
    });
  });

  test("takeover без причины отклоняется без смены участия", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const session = await history.start({ title: "Проверка причины передачи" }, "агент");
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(
        async () => await history.transition(session.id, "takeover", {}, historyOwner(session)),
        "INVALID_INPUT",
      );

      expect(snapshotHistoryStorage(db)).toEqual(before);
    });
  });

  test("pause с пробельной причиной отклоняется без смены состояния", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const session = await history.start({ title: "Проверка причины паузы" }, "агент");
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(
        async () =>
          await history.transition(
            session.id,
            "pause",
            { runId: session.data.currentRunId, reason: " " },
            historyOwner(session),
          ),
        "INVALID_INPUT",
      );

      expect(snapshotHistoryStorage(db)).toEqual(before);
    });
  });

  test("complete с пробельным результатом отклоняется без закрытия сессии", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const session = await history.start({ title: "Проверка результата" }, "агент");
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(
        async () =>
          await history.transition(
            session.id,
            "complete",
            { runId: session.data.currentRunId, result: " " },
            historyOwner(session),
          ),
        "INVALID_INPUT",
      );

      expect(snapshotHistoryStorage(db)).toEqual(before);
    });
  });

  test("унаследованное имя toString отклоняется как неизвестное действие без записи", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const session = await history.start({ title: "Проверка действия" }, "агент");
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(
        async () => await history.transition(session.id, "toString", {}, historyOwner(session)),
        "INVALID_INPUT",
      );

      expect(snapshotHistoryStorage(db)).toEqual(before);
    });
  });

  test("автор с нулевым символом отклоняется при start без создания сессии", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(
        async () => await history.start({ title: "Проверка автора" }, "агент\u0000"),
        "INVALID_ARGUMENT",
      );

      expect(snapshotHistoryStorage(db)).toEqual(before);
    });
  });

  test("автор с нулевым символом отклоняется при takeover без смены участия", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const session = await history.start({ title: "Владелец истории" }, "агент");
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(
        async () =>
          await history.transition(
            session.id,
            "takeover",
            { reason: "Смена участия" },
            { actor: "агент\u0000", ifRevision: session.revision },
          ),
        "INVALID_ARGUMENT",
      );

      expect(snapshotHistoryStorage(db)).toEqual(before);
    });
  });

  test("автор с нулевым символом отклоняется при checkpoint без записи материала", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const session = await history.start({ title: "Владелец материала" }, "агент");
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(
        async () =>
          await history.checkpoint(
            session.id,
            "open",
            {
              runId: session.data.currentRunId,
              title: "Намерение",
              body: "Проверить контракт",
            },
            { actor: "агент\u0000", ifRevision: session.revision },
          ),
        "INVALID_ARGUMENT",
      );

      expect(snapshotHistoryStorage(db)).toEqual(before);
    });
  });
});

describe("Повреждённые сохранённые данные истории", () => {
  test("runs: null отклоняется при чтении сессии без потери сохранённой строки", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const session = await history.start({ title: "Повреждённое участие" }, "агент");
      corruptHistoryRuns(db, session);
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(async () => history.get(session.id), "CORRUPT_DATA");

      expect(snapshotHistoryStorage(db)).toEqual(before);
    });
  });

  test("runs: null отклоняется при чтении списка вместо пропуска повреждённой сессии", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const session = await history.start({ title: "Повреждённое участие в списке" }, "агент");
      corruptHistoryRuns(db, session);
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(async () => history.list(), "CORRUPT_DATA");

      expect(snapshotHistoryStorage(db)).toEqual(before);
    });
  });

  test("runs: null блокирует takeover без перезаписи повреждённого состояния", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const session = await history.start(
        { title: "Повреждённое участие перед передачей" },
        "агент",
      );
      const corrupted = corruptHistoryRuns(db, session);
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(
        async () =>
          await history.transition(
            session.id,
            "takeover",
            { reason: "Продолжить работу" },
            { actor: "второй-агент", ifRevision: corrupted.revision },
          ),
        "CORRUPT_DATA",
      );

      expect(snapshotHistoryStorage(db)).toEqual(before);
    });
  });

  test("runs: null блокирует новый материал без изменения сессии и поколения", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const session = await history.start({ title: "Повреждённый владелец материала" }, "агент");
      const corrupted = corruptHistoryRuns(db, session);
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(
        async () =>
          await history.checkpoint(
            session.id,
            "open",
            {
              runId: session.data.currentRunId,
              title: "Намерение",
              body: "Проверить состояние",
            },
            { actor: "агент", ifRevision: corrupted.revision },
          ),
        "CORRUPT_DATA",
      );

      expect(snapshotHistoryStorage(db)).toEqual(before);
    });
  });

  test("references: null отклоняется при чтении материала вместо пустого массива", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const session = await history.start({ title: "Повреждённый материал" }, "агент");
      const intent = await openHistoryIntent(history, session);
      const corrupted = insertCorruptedHistoryCheckpoint(db, intent);
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(async () => history.getCheckpoint(corrupted.id), "CORRUPT_DATA");

      expect(snapshotHistoryStorage(db)).toEqual(before);
    });
  });

  test("references: null отклоняется при чтении истории вместо пропуска материала", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const session = await history.start({ title: "Повреждённый материал в истории" }, "агент");
      const intent = await openHistoryIntent(history, session);
      insertCorruptedHistoryCheckpoint(db, intent);
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(async () => history.history(session.id), "CORRUPT_DATA");

      expect(snapshotHistoryStorage(db)).toEqual(before);
    });
  });

  test("повреждённый соседний материал блокирует продолжение валидного намерения без записи", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const session = await history.start(
        { title: "Продолжение при повреждении истории" },
        "агент",
      );
      const intent = await openHistoryIntent(history, session);
      const current = history.get(session.id);
      insertCorruptedHistoryCheckpoint(db, intent);
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(
        async () => await recordHistoryMaterial(history, current, intent, "save"),
        "CORRUPT_DATA",
      );

      expect(snapshotHistoryStorage(db)).toEqual(before);
      expect(history.getCheckpoint(intent.id)).toEqual(intent);
      expect(history.get(session.id)).toEqual(current);
    });
  });
});

describe("Неизменяемость материалов и снимков участия", () => {
  test("создание материала сохраняет полный текст, основания и ревизию сессии", async () => {
    await withHistoryFixture(async (history) => {
      const session = await history.start({ title: "Сохранить основания проверки" }, "агент");

      const intent = await history.checkpoint(
        session.id,
        "open",
        {
          title: "Сопоставить исходные материалы",
          body: materialBody,
          runId: session.data.currentRunId,
          done: "- Прочитан контракт\n",
          remaining: "  - Проверить сохранение\n",
          nextStep: "Сопоставить данные после повторного открытия.",
          checks: "```sh\n  bun test\n```\n",
        },
        historyOwner(session),
      );

      expect(intent).toMatchObject({
        revision: 1,
        createdBy: "агент",
        updatedBy: "агент",
        data: {
          kind: "intent",
          sessionId: session.id,
          runId: session.data.currentRunId,
          actor: "агент",
          intentId: null,
          sequence: 1,
          sessionRevision: session.revision + 1,
          title: "Сопоставить исходные материалы",
          body: materialBody,
          summary: null,
          done: "- Прочитан контракт\n",
          remaining: "  - Проверить сохранение\n",
          nextStep: "Сопоставить данные после повторного открытия.",
          checks: "```sh\n  bun test\n```\n",
        },
      });
      expect(history.get(session.id).revision).toBe(intent.data.sessionRevision);
      expect(history.getCheckpoint(intent.id)).toEqual(intent);
    });
  });

  test("после изменения документа и открытия БД материалы сохраняют старый и новый снимки", async () => {
    await withHistoryFixture(async (history, { db, connect }) => {
      const knowledge = new KnowledgeService(db);
      const document = await knowledge.create(
        "document",
        { name: "Первоначальный контракт", body: "Исходные предметные правила." },
        "автор",
      );
      const session = await history.start({ title: "Проверить снимки документа" }, "агент");
      const intent = await history.checkpoint(
        session.id,
        "open",
        {
          title: "Сопоставить документ",
          body: materialBody,
          runId: session.data.currentRunId,
          references: [document.key],
        },
        historyOwner(session),
      );
      const initial = structuredClone(intent);
      const current = history.get(session.id);

      const updatedDocument = await knowledge.update(
        "document",
        document.id,
        { name: "Новая редакция", body: "Уточнённые предметные правила." },
        { actor: "автор", ifRevision: document.revision },
      );
      await knowledge.rename("document", document.id, "DOC-2", {
        actor: "автор",
        ifRevision: updatedDocument.revision,
      });
      const progress = await recordHistoryMaterial(history, current, intent, "save", {
        references: [`document:${document.id}`],
      });
      db.close();
      const reopened = new HistoryService(connect());

      expect(reopened.getCheckpoint(intent.id)).toEqual(initial);
      expect(reopened.getCheckpoint(progress.id)).toEqual(progress);
      expect(initial.data.references).toEqual([
        { id: document.id, kind: "document", key: "DOC-1", title: "Первоначальный контракт" },
      ]);
      expect(progress.data.references).toEqual([
        { id: document.id, kind: "document", key: "DOC-2", title: "Новая редакция" },
      ]);
      expect(progress.data.intentId).toBe(intent.id);
    });
  });

  test("новое участие и повторное открытие БД сохраняют материалы, авторство и оператора", async () => {
    await withHistoryFixture(async (history, { db, connect }) => {
      const session = await history.start(
        {
          title: "Проверить долговечность истории",
          description: "## Поручение\n\nСохранить основания.\n",
          operator: { name: "Анна", email: null, source: "explicit" },
          client: "терминал",
          sourceSessionId: "внешняя-сессия",
        },
        "агент-исследователь",
      );
      const intent = await openHistoryIntent(history, session);
      const current = history.get(session.id);
      const initial = structuredClone(intent);

      const transferred = await history.transition(
        session.key,
        "takeover",
        { reason: "Передать проверку другому агенту." },
        { actor: "агент-проверяющий", ifRevision: current.revision },
      );
      const progress = await recordHistoryMaterial(history, transferred, intent, "save");
      const result = await recordHistoryMaterial(
        history,
        history.get(session.id),
        intent,
        "complete",
      );
      const finished = await completeHistorySession(history, history.get(session.id));
      db.close();
      const reopened = new HistoryService(connect());

      expect(finished.data.currentRunId).toBeNull();
      expect(finished.data.runs.map((run) => run.state)).toEqual(["transferred", "completed"]);
      expect(finished.data.description).toBe("## Поручение\n\nСохранить основания.\n");
      expect(finished.data.runs[0]).toMatchObject({
        actor: "агент-исследователь",
        operator: { name: "Анна", email: null, source: "explicit" },
        client: "терминал",
        sourceSessionId: "внешняя-сессия",
      });
      expect(finished.data.runs[1]?.operator).toBeNull();
      expect(progress).toMatchObject({
        createdBy: "агент-проверяющий",
        updatedBy: "агент-проверяющий",
        data: {
          runId: transferred.data.currentRunId,
          actor: "агент-проверяющий",
          intentId: intent.id,
        },
      });
      expect(result.data.kind).toBe("result");
      expect(reopened.getCheckpoint(`work-checkpoint:${intent.id}`)).toEqual(initial);
      expect(reopened.getCheckpoint(progress.id)).toEqual(progress);
      expect(reopened.getCheckpoint(result.id)).toEqual(result);
      expect(reopened.get(`work-session:${session.id}`)).toEqual(finished);
      expect(reopened.history(session.key)).toEqual([initial, progress, result]);
      expect(reopened.history(session.key).map((entry) => entry.data.sequence)).toEqual([1, 2, 3]);
      expect(reopened.intents(session.id)).toEqual([]);
    });
  });

  test("изменение объекта ответа не переписывает сохранённый материал", async () => {
    await withHistoryFixture(async (history) => {
      const session = await history.start({ title: "Проверить независимость ответа" }, "агент");
      const intent = await openHistoryIntent(history, session);
      const initial = structuredClone(intent);

      intent.data.body = "Изменение объекта ответа";

      expect(history.getCheckpoint(intent.id)).toEqual(initial);
    });
  });
});

describe("CAS сессии и владение текущим участием", () => {
  test("устаревшая ревизия второго SQLite-соединения сохраняет победившую запись", async () => {
    await withHistoryFixture(async (history, { db, connect }) => {
      const second = new HistoryService(connect());
      const session = await history.start({ title: "Конкурентное сохранение" }, "агент");
      const stale = second.get(session.id);
      const intent = await openHistoryIntent(history, session);
      const current = history.get(session.id);
      const before = snapshotHistoryStorage(db);

      const error = await expectHistoryError(
        async () => await openHistoryIntent(second, stale),
        "REVISION_CONFLICT",
      );

      expect(error.details).toMatchObject({
        sessionId: session.id,
        expectedRevision: stale.revision,
        actualRevision: current.revision,
      });
      expect(snapshotHistoryStorage(db)).toEqual(before);
      expect(second.get(session.id)).toEqual(current);
      expect(second.history(session.id)).toEqual([intent]);
    });
  });

  test("takeover тем же автором создаёт новый run и закрывает прежний как transferred", async () => {
    await withHistoryFixture(async (history, { connect }) => {
      const second = new HistoryService(connect());
      const session = await history.start({ title: "Продолжить после обрыва клиента" }, "агент");
      const stale = second.get(session.id);

      const current = await second.transition(
        session.id,
        "takeover",
        { reason: "Продолжить после обрыва клиента." },
        historyOwner(stale),
      );

      expect(current.data.currentRunId).not.toBe(session.data.currentRunId);
      expect(current.data.runs[0]).toMatchObject({
        id: session.data.currentRunId,
        state: "transferred",
        endReason: "Продолжить после обрыва клиента.",
      });
      expect(current.data.runs[1]).toMatchObject({
        id: current.data.currentRunId,
        predecessorRunId: session.data.currentRunId,
        actor: "агент",
        state: "active",
      });
      expect(history.get(session.id)).toEqual(current);
    });
  });

  test("новый run после takeover тем же автором продолжает исходное намерение", async () => {
    await withHistoryFixture(async (history) => {
      const session = await history.start({ title: "Продолжить после смены клиента" }, "агент");
      const intent = await openHistoryIntent(history, session);
      const beforeTransfer = history.get(session.id);
      const current = await history.transition(
        session.id,
        "takeover",
        { reason: "Тот же исполнитель подключился из нового клиента." },
        historyOwner(beforeTransfer),
      );

      const progress = await recordHistoryMaterial(history, current, intent, "save");

      expect(progress.data).toMatchObject({
        kind: "progress",
        runId: current.data.currentRunId,
        actor: "агент",
        intentId: intent.id,
        sessionRevision: current.revision + 1,
      });
      expect(history.history(session.id)).toEqual([intent, progress]);
      expect(history.get(session.id).revision).toBe(current.revision + 1);
    });
  });

  test.each(rejectedRunReferences)("$name", async ({ form }) => {
    await withHistoryFixture(async (history, { db, connect }) => {
      const second = new HistoryService(connect());
      const session = await history.start({ title: "Проверить владельца после передачи" }, "агент");
      const intent = await openHistoryIntent(history, session);
      const beforeTransfer = second.get(session.id);
      const current = await second.transition(
        session.id,
        "takeover",
        { reason: "Продолжить после обрыва клиента." },
        historyOwner(beforeTransfer),
      );
      const references = {
        previousId: currentHistoryRun(session).id,
        currentKey: currentHistoryRun(current).key,
      };
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(
        async () =>
          await history.checkpoint(
            intent.id,
            "save",
            {
              title: "Запоздалая запись",
              body: "Проверить границу владения.",
              runId: references[form],
            },
            historyOwner(current),
          ),
        "CONFLICT",
      );

      expect(snapshotHistoryStorage(db)).toEqual(before);
      expect(history.get(session.id)).toEqual(current);
    });
  });

  test("чужой автор с текущими runId и ревизией отклоняется без записи", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const session = await history.start(
        { title: "Проверить автора владельческой записи" },
        "агент",
      );
      const intent = await openHistoryIntent(history, session);
      const current = history.get(session.id);
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(
        async () =>
          await history.checkpoint(
            intent.id,
            "save",
            {
              title: "Чужое авторство",
              body: "Не подменять автора.",
              runId: current.data.currentRunId,
            },
            { actor: "другой-агент", ifRevision: current.revision },
          ),
        "CONFLICT",
      );

      expect(snapshotHistoryStorage(db)).toEqual(before);
    });
  });
});

describe("Пауза, продолжение и закрытие участия", () => {
  test("pause закрывает участие с причиной и сохраняет открытое намерение", async () => {
    await withHistoryFixture(async (history) => {
      const session = await history.start({ title: "Ожидать уточнения" }, "первый-агент");
      const intent = await openHistoryIntent(history, session);
      const active = history.get(session.id);

      const paused = await history.transition(
        session.id,
        "pause",
        { runId: active.data.currentRunId, reason: "Ожидается уточнение поручения." },
        historyOwner(active),
      );

      expect(paused.data.status).toBe("paused");
      expect(paused.data.currentRunId).toBeNull();
      expect(paused.data.runs[0]).toMatchObject({
        state: "paused",
        endReason: "Ожидается уточнение поручения.",
      });
      expect(history.intents(session.id)).toEqual([intent]);
      expect(history.getCheckpoint(intent.id)).toEqual(intent);
    });
  });

  test("запись на паузе с прежним runId отклоняется без изменения истории", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const session = await history.start({ title: "Проверить запись на паузе" }, "первый-агент");
      const intent = await openHistoryIntent(history, session);
      const active = history.get(session.id);
      const paused = await history.transition(
        session.id,
        "pause",
        { runId: active.data.currentRunId, reason: "Ожидается уточнение." },
        historyOwner(active),
      );
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(
        async () =>
          await history.checkpoint(
            intent.id,
            "save",
            {
              title: "Запись на паузе",
              body: "Не должна сохраниться.",
              runId: session.data.currentRunId,
            },
            { actor: "первый-агент", ifRevision: paused.revision },
          ),
        "CONFLICT",
      );

      expect(snapshotHistoryStorage(db)).toEqual(before);
    });
  });

  test("открытое намерение запрещает отмену сессии на паузе без потери состояния", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const session = await history.start({ title: "Отмена на паузе" }, "первый-агент");
      await openHistoryIntent(history, session);
      const active = history.get(session.id);
      const paused = await history.transition(
        session.id,
        "pause",
        { runId: active.data.currentRunId, reason: "Ожидается уточнение." },
        historyOwner(active),
      );
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(
        async () =>
          await history.transition(
            session.id,
            "cancel",
            { result: "Отменить работу." },
            { actor: "пользователь", ifRevision: paused.revision },
          ),
        "CONFLICT",
      );

      expect(snapshotHistoryStorage(db)).toEqual(before);
    });
  });

  test("resume создаёт новое участие с оператором и сохраняет прежний run и намерение", async () => {
    await withHistoryFixture(async (history) => {
      const session = await history.start({ title: "Продолжение после паузы" }, "первый-агент");
      const intent = await openHistoryIntent(history, session);
      const active = history.get(session.id);
      const paused = await history.transition(
        session.id,
        "pause",
        { runId: active.data.currentRunId, reason: "Ожидается уточнение." },
        historyOwner(active),
      );

      const resumed = await history.transition(
        session.id,
        "resume",
        {
          reason: "Получено уточнение.",
          operator: { name: null, email: "user@example.test", source: "environment" },
        },
        { actor: "второй-агент", ifRevision: paused.revision },
      );

      expect(resumed.data.status).toBe("open");
      expect(resumed.data.currentRunId).not.toBe(session.data.currentRunId);
      expect(resumed.data.runs[0]).toEqual(paused.data.runs[0]);
      expect(currentHistoryRun(resumed)).toMatchObject({
        predecessorRunId: session.data.currentRunId,
        actor: "второй-агент",
        reason: "Получено уточнение.",
        operator: { name: null, email: "user@example.test", source: "environment" },
      });
      expect(history.intents(session.id)).toEqual([intent]);
    });
  });

  test("отмена намерения после resume добавляет материал и сохраняет исходное намерение", async () => {
    await withHistoryFixture(async (history) => {
      const session = await history.start({ title: "Пересмотр после паузы" }, "первый-агент");
      const intent = await openHistoryIntent(history, session);
      const active = history.get(session.id);
      const paused = await history.transition(
        session.id,
        "pause",
        { runId: active.data.currentRunId, reason: "Ожидается уточнение." },
        historyOwner(active),
      );
      const resumed = await history.transition(
        session.id,
        "resume",
        { reason: "Поручение пересмотрено." },
        { actor: "второй-агент", ifRevision: paused.revision },
      );

      const cancellation = await recordHistoryMaterial(history, resumed, intent, "cancel");

      expect(cancellation.data).toMatchObject({
        kind: "cancel",
        intentId: intent.id,
        runId: resumed.data.currentRunId,
        actor: "второй-агент",
      });
      expect(history.getCheckpoint(intent.id)).toEqual(intent);
      expect(history.intents(session.id)).toEqual([]);
      expect(history.history(session.id)).toEqual([intent, cancellation]);
    });
  });

  test("отмена после resume закрывает текущее участие и сохраняет прежнее вместе с результатом", async () => {
    await withHistoryFixture(async (history) => {
      const session = await history.start({ title: "Отменить поручение" }, "агент");
      const intent = await openHistoryIntent(history, session);
      const active = history.get(session.id);
      const paused = await history.transition(
        session.id,
        "pause",
        { runId: active.data.currentRunId, reason: "Ожидается уточнение." },
        historyOwner(active),
      );
      const resumed = await history.transition(
        session.id,
        "resume",
        { reason: "Поручение пересмотрено." },
        { actor: "второй-агент", ifRevision: paused.revision },
      );
      await recordHistoryMaterial(history, resumed, intent, "cancel");
      const ready = history.get(session.id);

      const cancelled = await history.transition(
        session.id,
        "cancel",
        { runId: ready.data.currentRunId, result: "Поручение больше не требуется." },
        historyOwner(ready),
      );

      expect(cancelled.data).toMatchObject({
        status: "cancelled",
        currentRunId: null,
        result: "Поручение больше не требуется.",
      });
      expect(cancelled.data.runs[0]).toEqual(paused.data.runs[0]);
      expect(cancelled.data.runs[1]).toMatchObject({
        id: resumed.data.currentRunId,
        state: "cancelled",
        endReason: "Поручение больше не требуется.",
      });
      expect(history.get(session.id)).toEqual(cancelled);
    });
  });

  test("takeover отменённой сессии отклоняется без изменения результата", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const session = await history.start({ title: "Отменённое поручение" }, "агент");
      const cancelled = await history.transition(
        session.id,
        "cancel",
        { runId: session.data.currentRunId, result: "Поручение больше не требуется." },
        historyOwner(session),
      );
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(
        async () =>
          await history.transition(
            session.id,
            "takeover",
            { reason: "Вернуть работу." },
            { actor: "агент", ifRevision: cancelled.revision },
          ),
        "CONFLICT",
      );

      expect(snapshotHistoryStorage(db)).toEqual(before);
    });
  });

  test("resume завершённой сессии отклоняется без изменения результата", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const session = await history.start({ title: "Завершённое поручение" }, "агент");
      const finished = await completeHistorySession(history, session);
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(
        async () =>
          await history.transition(
            session.id,
            "resume",
            {},
            { actor: "агент", ifRevision: finished.revision },
          ),
        "CONFLICT",
      );

      expect(snapshotHistoryStorage(db)).toEqual(before);
    });
  });
});

describe("Создание и подключение дочерней работы", () => {
  test("fork создаёт pending-ребёнка исходного намерения и повышает ревизию родителя", async () => {
    await withHistoryFixture(async (history) => {
      const parent = await history.start({ title: "Родительское поручение" }, "родитель");
      const intent = await openHistoryIntent(history, parent);
      const current = history.get(parent.id);

      const child = await forkHistorySession(history, current, intent);

      expect(child.revision).toBe(1);
      expect(child.data).toMatchObject({
        status: "pending",
        currentRunId: null,
        runs: [],
        parentSessionId: parent.id,
        originCheckpointId: intent.id,
        createdByRunId: parent.data.currentRunId,
      });
      expect(history.get(parent.id).revision).toBe(current.revision + 1);
      expect(history.get(parent.id).data.runs).toEqual(current.data.runs);
      expect(history.getCheckpoint(intent.id)).toEqual(intent);
      expect(history.tree(parent.id).map((entry) => entry.id)).toEqual([parent.id, child.id]);
    });
  });

  test("attach после takeover родителя наследует оператора создателя и открывает независимый run", async () => {
    await withHistoryFixture(async (history) => {
      const parent = await history.start(
        {
          title: "Родительское поручение",
          operator: { name: "Анна", email: "anna@example.test", source: "explicit" },
        },
        "родитель",
      );
      const intent = await openHistoryIntent(history, parent);
      const child = await forkHistorySession(history, history.get(parent.id), intent);
      const currentParent = history.get(parent.id);
      const transferred = await history.transition(
        parent.id,
        "takeover",
        {
          reason: "Передать корневое поручение.",
          operator: { name: "Борис", email: null, source: "explicit" },
        },
        { actor: "новый-родитель", ifRevision: currentParent.revision },
      );
      const beforeAttach = history.get(child.id);

      const attached = await history.transition(
        child.id,
        "attach",
        {},
        { actor: "субагент", ifRevision: child.revision },
      );

      expect(beforeAttach).toEqual(child);
      expect(attached.revision).toBe(child.revision + 1);
      expect(attached.data.status).toBe("open");
      expect(currentHistoryRun(attached)).toMatchObject({
        actor: "субагент",
        operator: { name: "Анна", email: "anna@example.test", source: "inherited" },
        predecessorRunId: null,
      });
      expect(attached.data.currentRunId).not.toBe(parent.data.currentRunId);
      expect(attached.data.currentRunId).not.toBe(transferred.data.currentRunId);
      expect(history.get(parent.id)).toEqual(transferred);
    });
  });

  test("явный operator: null при attach отключает наследование оператора родителя", async () => {
    await withHistoryFixture(async (history) => {
      const parent = await history.start(
        {
          title: "Родитель с оператором",
          operator: { name: "Анна", email: null, source: "explicit" },
        },
        "родитель",
      );
      const intent = await openHistoryIntent(history, parent);
      const child = await forkHistorySession(history, history.get(parent.id), intent);

      const attached = await history.transition(
        child.id,
        "attach",
        { operator: null },
        { actor: "субагент", ifRevision: child.revision },
      );

      expect(currentHistoryRun(attached).operator).toBeNull();
      expect(history.get(child.id)).toEqual(attached);
    });
  });

  test("переданный runId родителя при attach отклоняется без изменения ребёнка", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const parent = await history.start({ title: "Родительское поручение" }, "родитель");
      const intent = await openHistoryIntent(history, parent);
      const child = await forkHistorySession(history, history.get(parent.id), intent);
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(
        async () =>
          await history.transition(
            child.id,
            "attach",
            { runId: parent.data.currentRunId },
            { actor: "субагент", ifRevision: child.revision },
          ),
        "INVALID_INPUT",
      );

      expect(snapshotHistoryStorage(db)).toEqual(before);
    });
  });
});

describe("Приёмка результата и закрытие дочерней работы", () => {
  test.each(blockedChildClosures)("$name", async ({ action }) => {
    await withHistoryFixture(async (history, { db }) => {
      const parent = await history.start({ title: "Ожидать дочернюю работу" }, "родитель");
      const intent = await openHistoryIntent(history, parent);
      await forkHistorySession(history, history.get(parent.id), intent);
      const current = history.get(parent.id);
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(
        async () => await recordHistoryMaterial(history, current, intent, action),
        "CONFLICT",
      );

      expect(snapshotHistoryStorage(db)).toEqual(before);
    });
  });

  test("незавершённый подключённый ребёнок не принимается как результат", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const parent = await history.start({ title: "Дождаться результата" }, "родитель");
      const intent = await openHistoryIntent(history, parent);
      const child = await forkHistorySession(history, history.get(parent.id), intent);
      await history.transition(
        child.id,
        "attach",
        {},
        { actor: "субагент", ifRevision: child.revision },
      );
      const current = history.get(parent.id);
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(
        async () =>
          await recordHistoryMaterial(history, current, intent, "save", {
            acceptedSessionIds: [child.id],
          }),
        "CONFLICT",
      );

      expect(snapshotHistoryStorage(db)).toEqual(before);
    });
  });

  test("завершённый, но непринятый ребёнок запрещает закрыть исходное намерение", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const parent = await history.start({ title: "Явно принять результат" }, "родитель");
      const intent = await openHistoryIntent(history, parent);
      const child = await forkHistorySession(history, history.get(parent.id), intent);
      const attached = await history.transition(
        child.id,
        "attach",
        {},
        { actor: "субагент", ifRevision: child.revision },
      );
      await completeHistorySession(history, attached);
      const current = history.get(parent.id);
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(
        async () => await recordHistoryMaterial(history, current, intent, "complete"),
        "CONFLICT",
      );

      expect(snapshotHistoryStorage(db)).toEqual(before);
    });
  });

  test.each(rejectedAcceptanceReferences)("$name", async ({ form }) => {
    await withHistoryFixture(async (history, { db }) => {
      const parent = await history.start({ title: "Приёмка по постоянному ID" }, "родитель");
      const intent = await openHistoryIntent(history, parent);
      const child = await forkHistorySession(history, history.get(parent.id), intent);
      const attached = await history.transition(
        child.id,
        "attach",
        {},
        { actor: "субагент", ifRevision: child.revision },
      );
      await completeHistorySession(history, attached);
      const current = history.get(parent.id);
      const references = { key: child.key, typedId: `work-session:${child.id}` };
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(
        async () =>
          await recordHistoryMaterial(history, current, intent, "save", {
            acceptedSessionIds: [references[form]],
          }),
        "INVALID_INPUT",
      );

      expect(snapshotHistoryStorage(db)).toEqual(before);
    });
  });

  test("приёмка прямого ребёнка исходным намерением разрешает завершение родителя", async () => {
    await withHistoryFixture(async (history) => {
      const parent = await history.start({ title: "Принять дочернюю проверку" }, "родитель");
      const intent = await openHistoryIntent(history, parent);
      const child = await forkHistorySession(history, history.get(parent.id), intent);
      const attached = await history.transition(
        child.id,
        "attach",
        {},
        { actor: "субагент", ifRevision: child.revision },
      );
      const childIntent = await openHistoryIntent(history, attached);
      await recordHistoryMaterial(history, history.get(child.id), childIntent, "complete");
      const completedChild = await completeHistorySession(history, history.get(child.id));
      const current = history.get(parent.id);

      const acceptance = await recordHistoryMaterial(history, current, intent, "save", {
        acceptedSessionIds: [child.id],
      });
      await recordHistoryMaterial(history, history.get(parent.id), intent, "complete");
      const finished = await completeHistorySession(history, history.get(parent.id));

      expect(acceptance.data.acceptedSessionIds).toEqual([child.id]);
      expect(acceptance.data.intentId).toBe(intent.id);
      expect(history.get(child.id)).toEqual(completedChild);
      expect(finished.data.status).toBe("completed");
      expect(history.tree(parent.id)).toEqual([finished, completedChild]);
    });
  });

  test("результат внука отклоняется при приёмке корневым родителем без записи", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const parent = await history.start({ title: "Проверить прямое родительство" }, "родитель");
      const intent = await openHistoryIntent(history, parent);
      const child = await forkHistorySession(history, history.get(parent.id), intent);
      const attached = await history.transition(
        child.id,
        "attach",
        {},
        { actor: "субагент", ifRevision: child.revision },
      );
      const childIntent = await openHistoryIntent(history, attached);
      const grandchild = await forkHistorySession(history, history.get(child.id), childIntent);
      const grandAttached = await history.transition(
        grandchild.id,
        "attach",
        {},
        { actor: "вложенный-агент", ifRevision: grandchild.revision },
      );
      await completeHistorySession(history, grandAttached);
      const current = history.get(parent.id);
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(
        async () =>
          await recordHistoryMaterial(history, current, intent, "save", {
            acceptedSessionIds: [grandchild.id],
          }),
        "CONFLICT",
      );

      expect(snapshotHistoryStorage(db)).toEqual(before);
      expect(history.tree(parent.id).map((entry) => entry.id)).toEqual([
        parent.id,
        child.id,
        grandchild.id,
      ]);
    });
  });

  test("другое намерение того же родителя не принимает ребёнка исходного намерения", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const parent = await history.start({ title: "Проверить границы намерения" }, "родитель");
      const first = await openHistoryIntent(history, parent);
      const second = await openHistoryIntent(
        history,
        history.get(parent.id),
        "Проверить другой сценарий",
      );
      const child = await forkHistorySession(history, history.get(parent.id), first);
      const attached = await history.transition(
        child.id,
        "attach",
        {},
        { actor: "субагент", ifRevision: child.revision },
      );
      await completeHistorySession(history, attached);
      const current = history.get(parent.id);
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(
        async () =>
          await recordHistoryMaterial(history, current, second, "complete", {
            acceptedSessionIds: [child.id],
          }),
        "CONFLICT",
      );

      expect(snapshotHistoryStorage(db)).toEqual(before);
    });
  });

  test.each(acceptingClosureCases)("$name", async ({ action, expectedKind }) => {
    await withHistoryFixture(async (history) => {
      const parent = await history.start({ title: "Закрыть пересмотренное намерение" }, "родитель");
      const intent = await openHistoryIntent(history, parent);
      const child = await forkHistorySession(history, history.get(parent.id), intent);
      const attached = await history.transition(
        child.id,
        "attach",
        {},
        { actor: "субагент", ifRevision: child.revision },
      );
      const completedChild = await completeHistorySession(history, attached);
      const current = history.get(parent.id);

      const closure = await recordHistoryMaterial(history, current, intent, action, {
        acceptedSessionIds: [child.id],
      });
      const finished = await completeHistorySession(history, history.get(parent.id));

      expect(closure.data).toMatchObject({
        kind: expectedKind,
        intentId: intent.id,
        acceptedSessionIds: [child.id],
      });
      expect(history.getCheckpoint(intent.id)).toEqual(intent);
      expect(history.get(child.id)).toEqual(completedChild);
      expect(finished.data.status).toBe("completed");
    });
  });

  test("отменённый ребёнок отклоняется при приёмке как незавершённый результат", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const parent = await history.start({ title: "Проверить отменённый результат" }, "родитель");
      const intent = await openHistoryIntent(history, parent);
      const child = await forkHistorySession(history, history.get(parent.id), intent);
      await history.transition(
        child.id,
        "cancel",
        { result: "Проверка отменена до подключения." },
        { actor: "родитель", ifRevision: child.revision },
      );
      const current = history.get(parent.id);
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(
        async () =>
          await recordHistoryMaterial(history, current, intent, "save", {
            acceptedSessionIds: [child.id],
          }),
        "CONFLICT",
      );

      expect(snapshotHistoryStorage(db)).toEqual(before);
    });
  });

  test("отмена pending-ребёнка сохраняет причину и разрешает закрыть родителя без приёмки", async () => {
    await withHistoryFixture(async (history) => {
      const parent = await history.start({ title: "Закрыть ненужную дочернюю работу" }, "родитель");
      const intent = await openHistoryIntent(history, parent);
      const child = await forkHistorySession(history, history.get(parent.id), intent);

      const cancelled = await history.transition(
        child.id,
        "cancel",
        { result: "Проверка отменена до подключения." },
        { actor: "родитель", ifRevision: child.revision },
      );
      await recordHistoryMaterial(history, history.get(parent.id), intent, "complete");
      const finished = await completeHistorySession(history, history.get(parent.id));

      expect(cancelled.data).toMatchObject({
        status: "cancelled",
        currentRunId: null,
        runs: [],
        result: "Проверка отменена до подключения.",
      });
      expect(history.get(child.id)).toEqual(cancelled);
      expect(finished.data.status).toBe("completed");
      expect(history.tree(parent.id)).toEqual([finished, cancelled]);
    });
  });
});

describe("Атомарность составной записи истории", () => {
  test("отказ SQLite после вставки материала откатывает запись и не расходует sequence", async () => {
    await withHistoryFixture(async (history, { db, path }) => {
      const session = await history.start({ title: "Атомарное сохранение материала" }, "агент");
      const intent = await openHistoryIntent(history, session);
      const current = history.get(session.id);
      const before = snapshotHistoryStorage(db);

      await withHistorySessionUpdateFailure(path, async () => {
        const error = await expectHistoryError(
          async () => await recordHistoryMaterial(history, current, intent, "save"),
          "CONFLICT",
        );

        expect(error.details).toMatchObject({ reason: "Проверка отката составной записи" });
      });
      const rolledBack = snapshotHistoryStorage(db);
      const saved = await recordHistoryMaterial(history, current, intent, "save");

      expect(rolledBack).toEqual(before);
      expect(saved.data.sequence).toBe(2);
      expect(saved.data.sessionRevision).toBe(current.revision + 1);
      expect(history.history(session.id)).toEqual([intent, saved]);
    });
  });

  test("отказ SQLite после вставки ребёнка откатывает ребёнка, родителя и поколение", async () => {
    await withHistoryFixture(async (history, { db, path }) => {
      const session = await history.start({ title: "Атомарное создание ребёнка" }, "агент");
      const intent = await openHistoryIntent(history, session);
      const current = history.get(session.id);
      const before = snapshotHistoryStorage(db);

      await withHistorySessionUpdateFailure(path, async () => {
        const error = await expectHistoryError(
          async () => await forkHistorySession(history, current, intent),
          "CONFLICT",
        );

        expect(error.details).toMatchObject({ reason: "Проверка отката составной записи" });
      });

      expect(snapshotHistoryStorage(db)).toEqual(before);
      expect(history.list()).toEqual([current]);
      expect(history.history(session.id)).toEqual([intent]);
    });
  });

  test("отказ последнего шага batch откатывает fork и attach для другого SQLite-соединения", async () => {
    await withHistoryFixture(async (history, { db, connect }) => {
      const session = await history.start({ title: "Вложенная составная операция" }, "агент");
      const intent = await openHistoryIntent(history, session);
      await recordHistoryMaterial(history, history.get(session.id), intent, "save");
      const current = history.get(session.id);
      const observer = connect();
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(
        async () =>
          new CommandExecutor(db).executeCommands(
            [
              {
                op: "session.fork",
                ref: intent.id,
                as: "child",
                ifRevision: current.revision,
                input: { title: "Дочерняя проверка", runId: current.data.currentRunId },
              },
              { op: "session.attach", ref: { $ref: "child" }, ifRevision: 1, input: {} },
              // После attach ревизия ребёнка равна 2; исходная 1 не заменяется свежим CAS.
              {
                op: "session.cancel",
                ref: { $ref: "child" },
                ifRevision: 1,
                input: { result: "Отмена" },
              },
            ],
            { actor: "агент" },
          ),
        "REVISION_CONFLICT",
      );

      expect(snapshotHistoryStorage(observer)).toEqual(before);
      expect(new HistoryService(observer).get(session.id)).toEqual(current);
    });
  });
});

describe("Продолжение и закрытие намерений", () => {
  test("открытое намерение запрещает завершение сессии без изменения истории", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const session = await history.start({ title: "Закрыть намерения перед сессией" }, "агент");
      await openHistoryIntent(history, session);
      const current = history.get(session.id);
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(
        async () => await completeHistorySession(history, current),
        "CONFLICT",
      );

      expect(snapshotHistoryStorage(db)).toEqual(before);
    });
  });

  test("материал progress вместо intent отклоняется при продолжении без записи", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const session = await history.start({ title: "Продолжить исходное намерение" }, "агент");
      const intent = await openHistoryIntent(history, session);
      const progress = await recordHistoryMaterial(
        history,
        history.get(session.id),
        intent,
        "save",
      );
      const current = history.get(session.id);
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(
        async () => await recordHistoryMaterial(history, current, progress, "save"),
        "INVALID_INPUT",
      );

      expect(snapshotHistoryStorage(db)).toEqual(before);
    });
  });

  test("материал progress вместо intent отклоняется при fork без создания ребёнка", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const session = await history.start({ title: "Ответвление исходного намерения" }, "агент");
      const intent = await openHistoryIntent(history, session);
      const progress = await recordHistoryMaterial(
        history,
        history.get(session.id),
        intent,
        "save",
      );
      const current = history.get(session.id);
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(
        async () => await forkHistorySession(history, current, progress),
        "INVALID_INPUT",
      );

      expect(snapshotHistoryStorage(db)).toEqual(before);
    });
  });

  test.each(closedIntentActions)("$name", async ({ action }) => {
    await withHistoryFixture(async (history, { db }) => {
      const session = await history.start({ title: "Неизменяемое завершённое намерение" }, "агент");
      const intent = await openHistoryIntent(history, session);
      await recordHistoryMaterial(history, history.get(session.id), intent, "save");
      await recordHistoryMaterial(history, history.get(session.id), intent, "complete");
      const current = history.get(session.id);
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(
        async () => await recordHistoryMaterial(history, current, intent, action),
        "CONFLICT",
      );

      expect(snapshotHistoryStorage(db)).toEqual(before);
      expect(history.getCheckpoint(intent.id)).toEqual(intent);
      expect(history.history(session.id)).toHaveLength(3);
    });
  });

  test("fork закрытого намерения отклоняется без создания ребёнка и изменения родителя", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const session = await history.start({ title: "Ответвление после завершения" }, "агент");
      const intent = await openHistoryIntent(history, session);
      await recordHistoryMaterial(history, history.get(session.id), intent, "complete");
      const current = history.get(session.id);
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(
        async () => await forkHistorySession(history, current, intent),
        "CONFLICT",
      );

      expect(snapshotHistoryStorage(db)).toEqual(before);
      expect(history.getCheckpoint(intent.id)).toEqual(intent);
    });
  });
});

describe("Чтение намерений, контекста и списка сессий", () => {
  test("старое намерение и полный журнал доступны после восьми новых закрытых намерений", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const session = await history.start({ title: "Поиск старого намерения" }, "агент");
      const old = await openHistoryIntent(history, session);
      const expectedMaterials = [old];
      for (let index = 0; index < 8; index += 1) {
        const intent = await openHistoryIntent(
          history,
          history.get(session.id),
          `Проверить случай ${index + 1}`,
        );
        const result = await recordHistoryMaterial(
          history,
          history.get(session.id),
          intent,
          "complete",
        );
        expectedMaterials.push(intent, result);
      }
      const generation = db.getGeneration();

      const intents = history.intents(session.id);
      const allMaterials = history.history();
      const context = history.context(session.id);

      expect(intents).toEqual([old]);
      expect(allMaterials).toEqual(expectedMaterials);
      expect(context.checkpoints).toEqual(expectedMaterials);
      expect(context.intents).toEqual([old]);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("includeChildren добавляет открытые намерения ребёнка к намерениям родителя", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const parent = await history.start({ title: "Общее чтение намерений" }, "родитель");
      const parentIntent = await openHistoryIntent(history, parent);
      const child = await forkHistorySession(history, history.get(parent.id), parentIntent);
      const attached = await history.transition(
        child.id,
        "attach",
        {},
        { actor: "субагент", ifRevision: child.revision },
      );
      const childIntent = await openHistoryIntent(history, attached);
      const generation = db.getGeneration();

      const ownIntents = history.intents(parent.id);
      const allIntents = history.intents(parent.id, true);

      expect(ownIntents).toEqual([parentIntent]);
      // В одной миллисекунде разные сессии упорядочиваются по ID, а не по родительству.
      expect(allIntents).toHaveLength(2);
      expect(allIntents).toEqual(expect.arrayContaining([parentIntent, childIntent]));
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("контекст включает свои материалы и детей, а общая история также включает материалы ребёнка", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const parent = await history.start({ title: "Контекст поручения" }, "родитель");
      const intent = await openHistoryIntent(history, parent);
      const progress = await recordHistoryMaterial(history, history.get(parent.id), intent, "save");
      const child = await forkHistorySession(history, history.get(parent.id), intent);
      const attached = await history.transition(
        child.id,
        "attach",
        {},
        { actor: "субагент", ifRevision: child.revision },
      );
      const childIntent = await openHistoryIntent(history, attached);
      const currentParent = history.get(parent.id);
      const currentChild = history.get(child.id);
      const generation = db.getGeneration();

      const context = history.context(parent.id);
      const allMaterials = history.history();

      expect(context).toEqual({
        session: currentParent,
        checkpoints: [intent, progress],
        children: [currentChild],
        intents: [intent],
      });
      expect(allMaterials).toHaveLength(3);
      expect(allMaterials).toEqual(expect.arrayContaining([intent, progress, childIntent]));
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("unfinished: false возвращает только закрытую сессию без изменения поколения", async () => {
    await withHistoryFixture(async (history, { db }) => {
      await history.start({ title: "Открытое поручение" }, "агент");
      const closed = await completeHistorySession(
        history,
        await history.start({ title: "Закрытое поручение" }, "другой-агент"),
      );
      const generation = db.getGeneration();

      const sessions = history.list({ unfinished: false });

      expect(sessions).toEqual([closed]);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("фильтр по ключу родителя возвращает только его прямого ребёнка", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const parent = await history.start({ title: "Корневое поручение" }, "родитель");
      const intent = await openHistoryIntent(history, parent);
      const child = await forkHistorySession(history, history.get(parent.id), intent);
      await history.start({ title: "Другое корневое поручение" }, "другой-агент");
      const generation = db.getGeneration();

      const sessions = history.list({ parent: parent.key });

      expect(sessions).toEqual([child]);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("совместные фильтры находят открытую корневую сессию автора по описанию без учёта регистра", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const parent = await history.start(
        { title: "Поиск поручения", description: "Основания поиска" },
        "основной-агент",
      );
      const intent = await openHistoryIntent(history, parent);
      const beforeFork = history.get(parent.id);
      const child = await history.transition(
        intent.id,
        "fork",
        {
          title: "Дочернее поручение",
          description: "Основания поиска",
          runId: currentHistoryRun(beforeFork).id,
        },
        historyOwner(beforeFork),
      );
      await history.transition(
        child.id,
        "attach",
        {},
        { actor: "основной-агент", ifRevision: child.revision },
      );
      // Каждая лишняя сессия нарушает ровно один фильтр, чтобы условия не маскировали друг друга.
      await history.start(
        { title: "Другое поручение", description: "Иное содержание" },
        "основной-агент",
      );
      await history.start(
        { title: "Поручение другого автора", description: "Основания поиска" },
        "другой-агент",
      );
      await completeHistorySession(
        history,
        await history.start(
          { title: "Закрытое поручение", description: "Основания поиска" },
          "основной-агент",
        ),
      );
      const session = history.get(parent.id);
      const generation = db.getGeneration();

      const sessions = history.list({
        status: "open",
        actor: "основной-агент",
        q: "ОСНОВАНИЯ",
        parent: null,
      });

      expect(sessions).toEqual([session]);
      expect(db.getGeneration()).toBe(generation);
    });
  });
});
