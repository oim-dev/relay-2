import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { RelayError, type WriteOptions } from "@relay/contracts";
import { ProjectDatabase } from "@relay/storage";
import { HistoryService, type HistoryCheckpoint, type HistorySession } from "../../src/history";
import { KnowledgeService } from "../../src/knowledge";
import { TasksService } from "../../src/tasks";

interface Fixture {
  db: ProjectDatabase;
  history: HistoryService;
  path: string;
  connect(): HistoryService;
}

function fixture(operation: (context: Fixture) => void): void {
  const root = resolve(
    import.meta.dir,
    "../../../..",
    ".artifacts",
    new Date().toISOString().slice(0, 10),
  );
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "history-integration-"));
  const connections: ProjectDatabase[] = [];
  try {
    const path = join(directory, "project.sqlite");
    const db = ProjectDatabase.create(path, {
      id: crypto.randomUUID(),
      name: "История работы",
      slug: "history",
    });
    connections.push(db);
    operation({
      db,
      history: new HistoryService(db),
      path,
      connect() {
        const connection = ProjectDatabase.open(path);
        connections.push(connection);
        return new HistoryService(connection);
      },
    });
  } finally {
    for (const connection of connections) connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function owner(session: HistorySession): WriteOptions {
  const run = session.data.runs.find((entry) => entry.id === session.data.currentRunId)!;
  return { actor: run.actor, ifRevision: session.revision };
}

function open(history: HistoryService, session: HistorySession, title = "Исследовать контракт") {
  return history.checkpoint(
    session.key,
    "open",
    {
      title,
      body: "Сопоставить поведение с предметными правилами.",
      runId: session.data.currentRunId,
    },
    owner(session),
  );
}

function material(
  history: HistoryService,
  intent: HistoryCheckpoint,
  action: "save" | "complete" | "cancel",
  input: Record<string, unknown> = {},
): HistoryCheckpoint {
  const session = history.get(intent.data.sessionId);
  return history.checkpoint(
    intent.id,
    action,
    {
      title: "Проверен контракт истории",
      body: "Проверены условия сохранения материалов и закрытия работы.",
      runId: session.data.currentRunId,
      ...input,
    },
    owner(session),
  );
}

function fork(history: HistoryService, intent: HistoryCheckpoint): HistorySession {
  const parent = history.get(intent.data.sessionId);
  return history.transition(
    intent.key,
    "fork",
    {
      title: "Проверить отдельный сценарий",
      description: "Проверить результат и приложить основания.",
      runId: parent.data.currentRunId,
    },
    owner(parent),
  );
}

function complete(history: HistoryService, session: HistorySession): HistorySession {
  return history.transition(
    session.id,
    "complete",
    { runId: session.data.currentRunId, result: "Проверка завершена, результат сохранён." },
    owner(session),
  );
}

function fails(operation: () => unknown, code: string): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(RelayError);
    expect((error as RelayError).code).toBe(code);
    return;
  }
  throw new Error(`Ожидалась ошибка ${code}.`);
}

describe("HistoryService: реальная SQLite", () => {
  test.each(["null", "отсутствует"] as const)(
    "повреждённое обязательное имя цели (%s) не создаёт материал и не меняет сессию",
    (variant) =>
      fixture(({ db, history }) => {
        const knowledge = new KnowledgeService(db);
        const document = knowledge.create(
          "document",
          { name: "Исходное имя", body: "Текст" },
          "author",
        );
        const session = history.start({ title: "Проверить документ" }, "author");
        const data: Record<string, unknown> = { ...document.data };
        // Намеренная порча обязательного имени; подстановка ключа скрыла бы потерю содержания.
        if (variant === "null") data.name = null;
        else delete data.name;
        const damaged = { ...document, revision: document.revision + 1, data };
        db.update(damaged, document.revision);
        const generation = db.getGeneration();
        fails(
          () =>
            history.checkpoint(
              session.id,
              "open",
              {
                title: "Прочитать документ",
                body: "Сохранить основание работы",
                runId: session.data.currentRunId,
                references: [document.key],
              },
              owner(session),
            ),
          "CORRUPT_DATA",
        );
        expect(history.get(session.id)).toEqual(session);
        expect(db.list("work-checkpoint")).toEqual([]);
        expect(db.get(document.id)).toEqual(damaged);
        expect(db.getGeneration()).toBe(generation);
      }),
  );

  test("снимок допускает пустой паспорт продукта и пустой заголовок задачи без подмены текста", () =>
    fixture(({ db, history }) => {
      const product = new KnowledgeService(db).get("product");
      const task = new TasksService(db).create({}, "author");
      const session = history.start({ title: "Начать работу" }, "author");
      const checkpoint = history.checkpoint(
        session.id,
        "open",
        {
          title: "Определить содержание",
          body: "Паспорт и задача ещё не заполнены",
          runId: session.data.currentRunId,
          references: [product.key, task.key],
        },
        owner(session),
      );
      expect(checkpoint.data.references.map(({ id, title }) => ({ id, title }))).toEqual([
        { id: product.id, title: product.key },
        { id: task.id, title: "" },
      ]);
    }));

  test("материал разрешает виртуальные типизированные ссылки и отвергает неверный вид и дубликаты", () => {
    fixture(({ db, history }) => {
      const knowledge = new KnowledgeService(db);
      const application = knowledge.create(
        "application",
        { name: "Веб-клиент", slug: "web", prefix: "WEB" },
        "автор",
      );
      const board = knowledge.get("board", "board:product");
      const session = history.start({ title: "Ссылки из материала" }, "агент");
      const input = {
        title: "Проверить приложение",
        body: "Сохранить основания.",
        runId: session.data.currentRunId,
      };
      const intent = history.checkpoint(
        `work-session:${session.id}`,
        "open",
        {
          ...input,
          references: ["board:product", "application:web"],
        },
        owner(session),
      );
      expect(intent.data.references.map(({ id, kind }) => ({ id, kind }))).toEqual([
        { id: board.id, kind: "board" },
        { id: application.id, kind: "application" },
      ]);
      const current = history.get(session.id);
      const generation = db.getGeneration();
      fails(() => history.get(`work-checkpoint:${session.id}`), "INVALID_ARGUMENT");
      fails(() => history.getCheckpoint(`work-session:${intent.id}`), "INVALID_ARGUMENT");
      fails(
        () =>
          history.checkpoint(
            intent.id,
            "save",
            {
              ...input,
              references: [`task:${application.id}`],
            },
            owner(current),
          ),
        "NOT_FOUND",
      );
      fails(
        () =>
          history.checkpoint(
            intent.id,
            "save",
            {
              ...input,
              references: ["board:product", `board:${board.id}`],
            },
            owner(current),
          ),
        "INVALID_INPUT",
      );
      expect(history.get(session.id)).toEqual(current);
      expect(history.history(session.id)).toEqual([intent]);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("постороннее поле name задачи не подменяет проверенный заголовок в истории", () =>
    fixture(({ db, history }) => {
      const task = new TasksService(db).create({ title: "Проверенный заголовок" }, "author");
      // Внедряем не принадлежащее типу задачи поле через Storage. Оно не является названием задачи.
      db.update(
        { ...task, revision: task.revision + 1, data: { ...task.data, name: null } },
        task.revision,
      );
      const session = history.start({ title: "Проверить задачу" }, "author");
      const checkpoint = history.checkpoint(
        session.id,
        "open",
        {
          title: "Исследовать задачу",
          body: "Сохранить корректное название цели",
          runId: session.data.currentRunId,
          references: [task.id],
        },
        owner(session),
      );
      expect(checkpoint.data.references).toEqual([
        { id: task.id, kind: "task", key: task.key, title: "Проверенный заголовок" },
      ]);
      expect(history.getCheckpoint(checkpoint.id)).toEqual(checkpoint);
      expect(history.history(session.id)).toEqual([checkpoint]);
    }));

  test.each(["start", "takeover", "checkpoint"] as const)(
    "%s использует общее правило автора и отказывает без изменения истории",
    (action) => {
      fixture(({ db, history }) => {
        const session = history.start({ title: "Владелец истории" }, "агент");
        const generation = db.getGeneration();
        const actor = "агент\u0000";
        fails(() => {
          if (action === "start") return history.start({ title: "Другое поручение" }, actor);
          if (action === "takeover") {
            return history.transition(
              session.id,
              "takeover",
              { reason: "Смена участия" },
              { actor, ifRevision: session.revision },
            );
          }
          return history.checkpoint(
            session.id,
            "open",
            {
              runId: session.data.currentRunId,
              title: "Намерение",
              body: "Проверить контракт",
            },
            { actor, ifRevision: session.revision },
          );
        }, "INVALID_ARGUMENT");
        expect(history.list()).toEqual([session]);
        expect(history.history()).toEqual([]);
        expect(db.getGeneration()).toBe(generation);
      });
    },
  );

  test("повреждённый runs отвергается чтением и записью без потери сохранённого состояния", () => {
    fixture(({ db, history }) => {
      const session = history.start({ title: "Проверка сохранённого участия" }, "агент");
      // Намеренное повреждение через Storage: предметный сервис такого состояния не создаёт.
      db.update({ ...session, revision: 2, data: { ...session.data, runs: null } }, 1);
      const damaged = db.get(session.id)!;
      const generation = db.getGeneration();
      fails(() => history.get(session.id), "CORRUPT_DATA");
      fails(() => history.list(), "CORRUPT_DATA");
      fails(
        () =>
          history.transition(
            session.id,
            "takeover",
            { reason: "Продолжить работу" },
            {
              actor: "второй-агент",
              ifRevision: 2,
            },
          ),
        "CORRUPT_DATA",
      );
      fails(
        () =>
          history.checkpoint(
            session.id,
            "open",
            {
              runId: session.data.currentRunId,
              title: "Намерение",
              body: "Проверить состояние",
            },
            { actor: "агент", ifRevision: 2 },
          ),
        "CORRUPT_DATA",
      );
      expect(db.get(session.id)).toEqual(damaged);
      expect(db.list("work-checkpoint")).toEqual([]);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("повреждение checkpoint не выдаётся пустыми ссылками и блокирует продолжение без записи", () => {
    fixture(({ db, history }) => {
      const session = history.start({ title: "Проверка сохранённого материала" }, "агент");
      const intent = open(history, session);
      const current = history.get(session.id);
      // Storage используется только для намеренно недопустимого материала, не для рабочего сценария.
      const id = crypto.randomUUID();
      db.insert({ ...intent, id, key: `CP-${id}`, data: { ...intent.data, references: null } });
      const damaged = db.get(id)!;
      const materials = db.list("work-checkpoint");
      const generation = db.getGeneration();
      fails(() => history.getCheckpoint(id), "CORRUPT_DATA");
      fails(() => history.history(session.id), "CORRUPT_DATA");
      fails(() => material(history, intent, "save"), "CORRUPT_DATA");
      expect(db.get(id)).toEqual(damaged);
      expect(history.getCheckpoint(intent.id)).toEqual(intent);
      expect(history.get(session.id)).toEqual(current);
      expect(db.list("work-checkpoint")).toEqual(materials);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("материалы, авторство и снимки ссылок неизменяемы после нового участия и открытия БД", () => {
    fixture(({ db, history, connect }) => {
      const knowledge = new KnowledgeService(db);
      const document = knowledge.create(
        "document",
        { name: "Первоначальный контракт", body: "Исходные предметные правила." },
        "автор",
      );
      const session = history.start(
        {
          title: "Проверить историю",
          description: "## Поручение\n\nСохранить основания.\n",
          operator: { name: "Анна", email: null, source: "explicit" },
          client: "терминал",
          sourceSessionId: "внешняя-сессия",
        },
        "агент-исследователь",
      );
      const body = "\n## Основания\r\n\r\n```ts\r\n  const вывод = true;\r\n```\r\n\n";
      const intent = history.checkpoint(
        session.id,
        "open",
        {
          title: "Сопоставить исходные материалы",
          body,
          runId: session.data.currentRunId,
          references: [document.key],
          done: "- Прочитан контракт\n",
          remaining: "  - Проверить сохранение\n",
          nextStep: "Сопоставить данные после повторного открытия.",
          checks: "```sh\n  bun test\n```\n",
        },
        owner(session),
      );
      const initial = structuredClone(intent);
      expect(intent.data.body).toBe(body);
      expect(intent.data.summary).toBeNull();
      expect(intent.data.sessionRevision).toBe(2);
      expect(intent.data.references).toEqual([
        { id: document.id, kind: "document", key: "DOC-1", title: "Первоначальный контракт" },
      ]);
      const updatedDocument = knowledge.update(
        "document",
        document.id,
        { name: "Новая редакция", body: "Уточнённые предметные правила." },
        { actor: "автор", ifRevision: document.revision },
      );
      knowledge.rename("document", document.id, "DOC-2", {
        actor: "автор",
        ifRevision: updatedDocument.revision,
      });
      expect(history.getCheckpoint(intent.id)).toEqual(initial);
      const transferred = history.transition(
        session.key,
        "takeover",
        { reason: "Передать проверку другому агенту." },
        { actor: "агент-проверяющий", ifRevision: 2 },
      );
      const progress = material(history, intent, "save", {
        references: [`document:${document.id}`],
      });
      const result = material(history, intent, "complete");
      const finished = complete(history, history.get(session.id));
      expect(finished.data.currentRunId).toBeNull();
      expect(finished.data.runs.map((run) => run.state)).toEqual(["transferred", "completed"]);
      expect(finished.data.runs[0]?.operator?.name).toBe("Анна");
      expect(finished.data.runs[1]?.operator).toBeNull();
      expect(progress.data.runId).toBe(transferred.data.currentRunId!);
      expect(progress.data.references).toEqual([
        { id: document.id, kind: "document", key: "DOC-2", title: "Новая редакция" },
      ]);
      expect(progress.data.intentId).toBe(intent.id);
      expect(result.data.kind).toBe("result");
      db.close();
      const reopened = connect();
      expect(reopened.getCheckpoint(`work-checkpoint:${intent.id}`)).toEqual(initial);
      expect(reopened.getCheckpoint(progress.id)).toEqual(progress);
      expect(reopened.get(`work-session:${session.id}`)).toEqual(finished);
      expect(reopened.history(session.key).map((entry) => entry.data.sequence)).toEqual([1, 2, 3]);
      expect(reopened.intents(session.id)).toEqual([]);
      intent.data.body = "Изменение объекта ответа";
      expect(reopened.getCheckpoint(intent.id).data.body).toBe(body);
      fails(
        () =>
          reopened.transition(
            session.id,
            "resume",
            {},
            { actor: "агент", ifRevision: finished.revision },
          ),
        "CONFLICT",
      );
    });
  });

  test("две SQLite-связи: CAS и старый run со свежей ревизией независимо защищают запись", () => {
    fixture(({ history, connect, db }) => {
      const second = connect();
      const session = history.start({ title: "Конкурентное сохранение" }, "агент");
      const stale = second.get(session.id);
      const intent = open(history, session);
      const before = db.getGeneration();
      fails(() => open(second, stale), "REVISION_CONFLICT");
      expect(db.getGeneration()).toBe(before);
      expect(history.history(session.id)).toEqual([intent]);
      const current = second.transition(
        session.id,
        "takeover",
        { reason: "Продолжить после обрыва клиента." },
        { actor: "агент", ifRevision: 2 },
      );
      expect(current.data.currentRunId).not.toBe(session.data.currentRunId);
      expect(current.data.runs[1]?.predecessorRunId).toBe(session.data.currentRunId);
      for (const runId of [session.data.currentRunId, current.data.runs[1]!.key]) {
        fails(
          () =>
            history.checkpoint(
              intent.id,
              "save",
              { title: "Запоздалая запись", body: "Проверка fencing.", runId },
              owner(current),
            ),
          "CONFLICT",
        );
      }
      fails(
        () =>
          history.checkpoint(
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
      expect(history.get(session.id)).toEqual(current);
      expect(material(history, intent, "save").data.runId).toBe(current.data.currentRunId!);
    });
  });

  test("pause сохраняет открытые intents, resume создаёт новое участие; отмена требует закрытия", () => {
    fixture(({ history }) => {
      const session = history.start({ title: "Продолжение после паузы" }, "первый-агент");
      const intent = open(history, session);
      const active = history.get(session.id);
      const paused = history.transition(
        session.id,
        "pause",
        { runId: active.data.currentRunId, reason: "Ожидается уточнение поручения." },
        owner(active),
      );
      expect(paused.data.status).toBe("paused");
      expect(paused.data.currentRunId).toBeNull();
      expect(paused.data.runs[0]?.endReason).toBe("Ожидается уточнение поручения.");
      expect(history.intents(session.id).map((entry) => entry.id)).toEqual([intent.id]);
      fails(
        () =>
          history.checkpoint(
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
      fails(
        () =>
          history.transition(
            session.id,
            "cancel",
            { result: "Отменить работу." },
            { actor: "пользователь", ifRevision: paused.revision },
          ),
        "CONFLICT",
      );
      const resumed = history.transition(
        session.id,
        "resume",
        {
          reason: "Получено уточнение.",
          operator: { name: null, email: "user@example.test", source: "environment" },
        },
        { actor: "второй-агент", ifRevision: paused.revision },
      );
      expect(resumed.data.runs[0]).toEqual(paused.data.runs[0]!);
      expect(resumed.data.runs[1]?.predecessorRunId).toBe(session.data.currentRunId);
      const cancelledIntent = material(history, intent, "cancel");
      expect(cancelledIntent.data.kind).toBe("cancel");
      expect(history.getCheckpoint(intent.id)).toEqual(intent);
      const ready = history.get(session.id);
      const cancelled = history.transition(
        session.id,
        "cancel",
        { runId: ready.data.currentRunId, result: "Поручение больше не требуется." },
        owner(ready),
      );
      expect(cancelled.data.status).toBe("cancelled");
      expect(cancelled.data.runs[1]?.state).toBe("cancelled");
      expect(cancelled.data.result).toBe("Поручение больше не требуется.");
      fails(
        () =>
          history.transition(
            session.id,
            "takeover",
            { reason: "Вернуть работу." },
            { actor: "агент", ifRevision: cancelled.revision },
          ),
        "CONFLICT",
      );
    });
  });

  test("fork/attach: наследование пользователя создателя, независимые runs и явное принятие результата", () => {
    fixture(({ history }) => {
      const parent = history.start(
        {
          title: "Родительское поручение",
          operator: { name: "Анна", email: "anna@example.test", source: "explicit" },
        },
        "родитель",
      );
      const intent = open(history, parent);
      const child = fork(history, intent);
      expect(child.data).toMatchObject({
        status: "pending",
        currentRunId: null,
        runs: [],
        parentSessionId: parent.id,
        originCheckpointId: intent.id,
        createdByRunId: parent.data.currentRunId,
      });
      expect(history.get(parent.id).revision).toBe(3);
      fails(() => material(history, intent, "complete"), "CONFLICT");
      fails(() => material(history, intent, "cancel"), "CONFLICT");
      const transferred = history.transition(
        parent.id,
        "takeover",
        {
          reason: "Передать корневое поручение.",
          operator: { name: "Борис", email: null, source: "explicit" },
        },
        { actor: "новый-родитель", ifRevision: 3 },
      );
      expect(history.get(child.id)).toEqual(child);
      fails(
        () =>
          history.transition(
            child.id,
            "attach",
            { runId: parent.data.currentRunId },
            { actor: "субагент", ifRevision: 1 },
          ),
        "INVALID_INPUT",
      );
      const attached = history.transition(
        child.id,
        "attach",
        {},
        { actor: "субагент", ifRevision: 1 },
      );
      expect(attached.data.runs[0]?.operator).toEqual({
        name: "Анна",
        email: "anna@example.test",
        source: "inherited",
      });
      expect(attached.data.currentRunId).not.toBe(transferred.data.currentRunId);
      fails(
        () => material(history, intent, "save", { acceptedSessionIds: [child.id] }),
        "CONFLICT",
      );
      const childIntent = open(history, attached);
      material(history, childIntent, "complete");
      const completedChild = complete(history, history.get(child.id));
      fails(() => material(history, intent, "complete"), "CONFLICT");
      fails(
        () => material(history, intent, "save", { acceptedSessionIds: [child.key] }),
        "INVALID_INPUT",
      );
      fails(
        () =>
          material(history, intent, "save", { acceptedSessionIds: [`work-session:${child.id}`] }),
        "INVALID_INPUT",
      );
      const acceptance = material(history, intent, "save", { acceptedSessionIds: [child.id] });
      expect(acceptance.data.acceptedSessionIds).toEqual([child.id]);
      expect(history.get(child.id)).toEqual(completedChild);
      material(history, intent, "complete");
      expect(complete(history, history.get(parent.id)).data.status).toBe("completed");
      expect(history.tree(parent.id).map((entry) => entry.id)).toEqual([parent.id, child.id]);
    });
  });

  test("принятие принадлежит исходному intent и прямому родителю; отменённый ребёнок не результат", () => {
    fixture(({ history }) => {
      const parent = history.start({ title: "Проверить границы принятия" }, "родитель");
      const first = open(history, parent);
      const second = open(history, history.get(parent.id), "Проверить другой сценарий");
      const child = fork(history, first);
      const attached = history.transition(
        child.id,
        "attach",
        { operator: null },
        { actor: "субагент", ifRevision: 1 },
      );
      const childIntent = open(history, attached);
      const grandchild = fork(history, childIntent);
      const grandAttached = history.transition(
        grandchild.id,
        "attach",
        {},
        { actor: "вложенный-агент", ifRevision: 1 },
      );
      complete(history, grandAttached);
      fails(
        () => material(history, first, "save", { acceptedSessionIds: [grandchild.id] }),
        "CONFLICT",
      );
      material(history, childIntent, "complete", { acceptedSessionIds: [grandchild.id] });
      complete(history, history.get(child.id));
      fails(
        () => material(history, second, "complete", { acceptedSessionIds: [child.id] }),
        "CONFLICT",
      );
      material(history, first, "cancel", { acceptedSessionIds: [child.id] });
      const cancelledChild = fork(history, second);
      history.transition(
        cancelledChild.id,
        "cancel",
        { result: "Проверка отменена до подключения." },
        { actor: "родитель", ifRevision: 1 },
      );
      fails(
        () => material(history, second, "save", { acceptedSessionIds: [cancelledChild.id] }),
        "CONFLICT",
      );
      material(history, second, "complete");
      expect(complete(history, history.get(parent.id)).data.status).toBe("completed");
      expect(history.get(cancelledChild.id).data.result).toBe("Проверка отменена до подключения.");
      expect(history.tree(parent.id)).toHaveLength(4);
    });
  });

  test("отказ SQLite после вставки checkpoint или ребёнка откатывает составную запись и поколение", () => {
    fixture(({ db, history, path, connect }) => {
      const session = history.start({ title: "Атомарная история" }, "агент");
      const intent = open(history, session);
      const before = history.get(session.id);
      const generation = db.getGeneration();
      const connection = new Database(path, { create: false, readwrite: true });
      try {
        connection.exec(`
          CREATE TRIGGER history_fail_session BEFORE UPDATE ON entities
          WHEN OLD.kind = 'work-session'
          BEGIN SELECT RAISE(ABORT, 'Проверка отката составной записи'); END;
        `);
        fails(() => material(history, intent, "save"), "CONFLICT");
        fails(() => fork(history, intent), "CONFLICT");
        expect(db.getGeneration()).toBe(generation);
        expect(history.get(session.id)).toEqual(before);
        expect(history.history(session.id)).toEqual([intent]);
        expect(history.list()).toHaveLength(1);
        connection.exec("DROP TRIGGER history_fail_session");
      } finally {
        connection.close();
      }
      expect(material(history, intent, "save").data.sequence).toBe(2);
      const saved = history.get(session.id);
      const observer = connect();
      expect(() =>
        db.transaction(() => {
          const nested = fork(history, intent);
          history.transition(nested.id, "attach", {}, { actor: "субагент", ifRevision: 1 });
          throw new Error("Отказ внешней составной операции");
        }),
      ).toThrow("Отказ внешней составной операции");
      expect(observer.get(session.id)).toEqual(saved);
      expect(observer.list()).toHaveLength(1);
    });
  });

  test("закрытый intent и не-intent не принимают продолжение и fork, session требует закрытия", () => {
    fixture(({ history }) => {
      const session = history.start({ title: "Закрытие намерений" }, "агент");
      const intent = open(history, session);
      fails(() => complete(history, history.get(session.id)), "CONFLICT");
      const progress = material(history, intent, "save");
      fails(() => material(history, progress, "save"), "INVALID_INPUT");
      fails(() => fork(history, progress), "INVALID_INPUT");
      material(history, intent, "complete");
      for (const action of ["save", "complete", "cancel"] as const) {
        fails(() => material(history, intent, action), "CONFLICT");
      }
      fails(() => fork(history, intent), "CONFLICT");
      expect(history.getCheckpoint(intent.id)).toEqual(intent);
      expect(history.history(session.id)).toHaveLength(3);
    });
  });

  test("чтения находят старые открытые intents, фильтруют сессии и не изменяют поколение", () => {
    fixture(({ db, history }) => {
      const session = history.start(
        { title: "Поиск старого намерения", description: "Основания поиска" },
        "основной-агент",
      );
      const old = open(history, session);
      for (let index = 0; index < 8; index += 1) {
        const intent = open(history, history.get(session.id), `Проверить случай ${index + 1}`);
        material(history, intent, "complete");
      }
      const child = fork(history, old);
      const attached = history.transition(
        child.id,
        "attach",
        {},
        { actor: "субагент", ifRevision: 1 },
      );
      const childIntent = open(history, attached);
      const closed = complete(
        history,
        history.start({ title: "Закрытое поручение" }, "другой-агент"),
      );
      const generation = db.getGeneration();
      expect(history.intents(session.id).map((entry) => entry.id)).toEqual([old.id]);
      expect(history.intents(session.id, true).map((entry) => entry.id)).toEqual([
        old.id,
        childIntent.id,
      ]);
      expect(history.list({ unfinished: false }).map((entry) => entry.id)).toEqual([closed.id]);
      expect(history.list({ parent: session.key }).map((entry) => entry.id)).toEqual([child.id]);
      expect(
        history
          .list({ status: "open", actor: "основной-агент", q: "ОСНОВАНИЯ", parent: null })
          .map((entry) => entry.id),
      ).toEqual([session.id]);
      expect(history.history()).toHaveLength(18);
      const context = history.context(session.id);
      expect(context.checkpoints).toHaveLength(17);
      expect(context.children.map((entry) => entry.id)).toEqual([child.id]);
      expect(context.intents).toEqual([old]);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("непроверенный ввод, пустые материалы, вымышленные ссылки и ревизии отвергаются без записи", () => {
    fixture(({ db, history }) => {
      for (const input of [
        null,
        [],
        "поручение",
        {},
        { title: "  " },
        { title: "Первая\nВторая" },
        { title: "Поручение", extra: true },
        { title: "Поручение", operator: { name: 1, source: "explicit" } },
      ]) {
        fails(() => history.start(input as Record<string, unknown>, "агент"), "INVALID_INPUT");
      }
      expect(history.list()).toEqual([]);
      const session = history.start({ title: "Проверка ввода" }, "агент");
      const generation = db.getGeneration();
      const valid = {
        title: "Проверить вход",
        body: "Содержательный материал.",
        runId: session.data.currentRunId,
      };
      for (const input of [
        { ...valid, body: "\n \t" },
        { ...valid, title: 42 },
        { ...valid, references: [42] },
        { ...valid, references: new Array(1) },
        { ...valid, unknown: true },
        { ...valid, acceptedSessionIds: [] },
      ]) {
        fails(() => history.checkpoint(session.id, "open", input, owner(session)), "INVALID_INPUT");
      }
      for (const ifRevision of [0, -1, 1.5, NaN, Infinity, "1"]) {
        fails(
          () =>
            history.checkpoint(session.id, "open", valid, {
              actor: "агент",
              ifRevision,
            } as WriteOptions),
          "INVALID_INPUT",
        );
      }
      fails(
        () =>
          history.checkpoint(
            session.id,
            "open",
            { ...valid, references: [crypto.randomUUID()] },
            owner(session),
          ),
        "NOT_FOUND",
      );
      fails(() => history.transition(session.id, "takeover", {}, owner(session)), "INVALID_INPUT");
      fails(
        () =>
          history.transition(
            session.id,
            "pause",
            { runId: session.data.currentRunId, reason: " " },
            owner(session),
          ),
        "INVALID_INPUT",
      );
      fails(
        () =>
          history.transition(
            session.id,
            "complete",
            { runId: session.data.currentRunId, result: " " },
            owner(session),
          ),
        "INVALID_INPUT",
      );
      fails(() => history.transition(session.id, "toString", {}, owner(session)), "INVALID_INPUT");
      expect(history.get(session.id)).toEqual(session);
      expect(history.history()).toEqual([]);
      expect(db.getGeneration()).toBe(generation);
    });
  });
});
