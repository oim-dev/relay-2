import { describe, expect, spyOn, test } from "bun:test";
import type { HistoryCheckpoint, HistorySession } from "@relay/contracts";
import type { ProjectDatabase } from "@relay/storage";
import { CommandExecutor } from "../../src/batch/batch";
import { HistoryService } from "../../src/history/history";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import {
  completeHistorySession,
  currentHistoryRun,
  expectHistoryError,
  forkHistorySession,
  historyOwner,
  openHistoryIntent,
  recordHistoryMaterial,
  snapshotHistoryStorage,
  withHistoryFixture,
} from "./history-fixture";

const checkpointActions = [
  { action: "open", kind: "intent" },
  { action: "save", kind: "progress" },
  { action: "complete", kind: "result" },
  { action: "cancel", kind: "cancel" },
] as const;
const acceptingActions = ["save", "complete", "cancel"] as const;
const addressPrefixes = ["", "S-", "CP-", "RUN-"] as const;
const corruptedChildLinks = ["parentSessionId", "originCheckpointId"] as const;
const foreignMarker = "Содержание чужой истории не требуется для записи";

/**
 * Выполняет реальный сценарий с проверкой отсутствия полного списка и декодирования чужого JSON.
 * Перехваты не заменяют данные SQLite; всегда восстанавливаются, включая предметный отказ.
 */
async function expectLocalHistoryReads<T>(
  db: ProjectDatabase,
  operation: () => Promise<T>,
): Promise<T> {
  const fullReads = spyOn(db, "list");
  const loads = spyOn(db.commands, "load");
  /**
   * Сохраняет настоящий декодер JSON до наблюдения загружаемого содержания.
   */
  const parse: typeof JSON.parse = JSON.parse;
  const foreignJson: string[] = [];
  const decoder = spyOn(JSON, "parse").mockImplementation((text, reviver) => {
    if (text.includes(foreignMarker)) {
      foreignJson.push(text);
    }
    return parse(text, reviver);
  });
  try {
    const result = await operation();

    expect(fullReads).not.toHaveBeenCalled();
    expect(
      loads.mock.calls
        .flatMap(([request]) => request.selectors)
        .some((selector) => selector.kind === "kind"),
    ).toBe(false);
    expect(foreignJson).toEqual([]);
    return result;
  } finally {
    decoder.mockRestore();
    loads.mockRestore();
    fullReads.mockRestore();
  }
}

/**
 * Подставляет UUID для первых выделений до завершения async сценария, затем использует исходный генератор.
 * Нужен для воспроизводимой коллизии настоящих записей; глобальный генератор восстанавливается.
 */
async function withHistoryIds<T>(
  ids: readonly ReturnType<Crypto["randomUUID"]>[],
  operation: () => Promise<T>,
): Promise<T> {
  /**
   * Сохраняет штатный генератор для выделений после заданных тестом коллизий.
   */
  const original: Crypto["randomUUID"] = crypto.randomUUID.bind(crypto);
  let index = 0;
  const generator = spyOn(crypto, "randomUUID").mockImplementation(
    () => ids[index++] ?? original(),
  );
  try {
    return await operation();
  } finally {
    generator.mockRestore();
  }
}

/**
 * Создаёт и завершает прямого ребёнка без собственных материалов через публичные переходы.
 * Ревизия родителя передаётся явно; ребёнок остаётся непринятым исходным намерением.
 */
async function completedHistoryChild(
  history: HistoryService,
  parent: HistorySession,
  intent: HistoryCheckpoint,
): Promise<HistorySession> {
  const child = await forkHistorySession(history, parent, intent);
  const attached = await history.transition(
    child.id,
    "attach",
    {},
    { actor: "исполнитель-ребёнка", ifRevision: child.revision },
  );
  return await completeHistorySession(history, attached);
}

describe("Ограниченные чтения записи checkpoint", () => {
  test.each([
    "start",
    "fork",
    "attach",
    "resume",
    "takeover",
    "pause",
    "complete",
    "cancel",
  ] as const)("session.%s не читает каталог сессий или чужую историю", async (action) => {
    await withHistoryFixture(async (history, { db }) => {
      let owner = await history.start({ title: "Выбранная работа" }, "автор");
      let ref = owner.id;
      if (action === "fork" || action === "attach") {
        const intent = await openHistoryIntent(history, owner);
        owner = history.get(owner.id);
        ref = intent.id;
        if (action === "attach") {
          owner = await forkHistorySession(history, owner, intent);
          ref = owner.id;
        }
      } else if (action === "resume") {
        owner = await history.transition(
          owner.id,
          "pause",
          { runId: owner.data.currentRunId, reason: "Подготовить паузу" },
          historyOwner(owner),
        );
      }
      const foreign = await history.start({ title: foreignMarker }, "чужой");
      const foreignIntent = await openHistoryIntent(history, foreign, foreignMarker);
      const foreignBefore = history.get(foreign.id);
      const input = {
        start: { title: "Новый корень" },
        fork: { title: "Ребёнок", runId: owner.data.currentRunId },
        attach: {},
        resume: {},
        takeover: { reason: "Передача" },
        pause: { runId: owner.data.currentRunId, reason: "Пауза" },
        complete: { runId: owner.data.currentRunId, result: "Готово" },
        cancel: { runId: owner.data.currentRunId, result: "Отменено" },
      };

      const result = await expectLocalHistoryReads(db, () =>
        action === "start"
          ? history.start(input.start, "автор")
          : history.transition(ref, action, input[action], {
              actor: "автор",
              ifRevision: owner.revision,
            }),
      );

      const statuses = {
        start: "open",
        fork: "pending",
        attach: "open",
        resume: "open",
        takeover: "open",
        pause: "paused",
        complete: "completed",
        cancel: "cancelled",
      } as const;
      expect(result.data.status).toBe(statuses[action]);
      expect(history.get(result.id)).toEqual(result);
      expect(history.get(foreign.id)).toEqual(foreignBefore);
      expect(history.getCheckpoint(foreignIntent.id)).toEqual(foreignIntent);
    });
  });

  test("несохранённые run и session ID зарезервированы между шагами одного batch", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const runId = crypto.randomUUID();
      const sessionId = crypto.randomUUID();
      const secondRunId = crypto.randomUUID();
      const secondSessionId = crypto.randomUUID();

      const result = await withHistoryIds(
        [runId, runId, sessionId, runId, secondRunId, secondSessionId],
        () =>
          new CommandExecutor(db).executeCommands(
            [
              { op: "session.start", input: { title: "Первый корень" } },
              { op: "session.start", input: { title: "Второй корень" } },
            ],
            { actor: "автор" },
          ),
      );

      expect(result.items.map((entry) => entry.id)).toEqual([sessionId, secondSessionId]);
      expect(history.get(sessionId).data.currentRunId).toBe(runId);
      expect(history.get(secondSessionId).data.currentRunId).toBe(secondRunId);
      expect(db.count("work-session")).toBe(2);
    });
  });

  test.each(checkpointActions)(
    "$action не загружает чужую историю ради sequence и ID",
    async ({ action, kind }) => {
      await withHistoryFixture(async (history, { db }) => {
        const session = await history.start({ title: "Выбранная сессия" }, "автор");
        const intent = await openHistoryIntent(history, session);
        const foreign = await history.start({ title: foreignMarker }, "другой-автор");
        const foreignIntent = await openHistoryIntent(history, foreign, foreignMarker);
        const foreignProgress = await recordHistoryMaterial(
          history,
          history.get(foreign.id),
          foreignIntent,
          "save",
        );
        const foreignSession = history.get(foreign.id);
        const current = history.get(session.id);
        const generation = db.getGeneration();

        const checkpoint = await expectLocalHistoryReads(
          db,
          async () =>
            await history.checkpoint(
              action === "open" ? session.key : intent.id,
              action,
              {
                runId: currentHistoryRun(current).id,
                title: "Новый материал",
                body: "Полное содержание выбранного материала.\n",
              },
              historyOwner(current),
            ),
        );

        expect(checkpoint).toMatchObject({
          revision: 1,
          createdBy: "автор",
          updatedBy: "автор",
          data: {
            kind,
            sessionId: session.id,
            runId: currentHistoryRun(current).id,
            actor: "автор",
            intentId: action === "open" ? null : intent.id,
            sequence: 2,
            sessionRevision: current.revision + 1,
            body: "Полное содержание выбранного материала.\n",
          },
        });
        expect(history.getCheckpoint(checkpoint.id)).toEqual(checkpoint);
        expect(history.getCheckpoint(intent.id)).toEqual(intent);
        expect(history.getCheckpoint(foreignIntent.id)).toEqual(foreignIntent);
        expect(history.getCheckpoint(foreignProgress.id)).toEqual(foreignProgress);
        expect(history.get(foreign.id)).toEqual(foreignSession);
        expect(history.get(session.id).revision).toBe(current.revision + 1);
        expect(db.getGeneration()).toBe(generation + 2);
      });
    },
  );

  test.each(acceptingActions)(
    "%s принимает двух детей пакетом без адресного чтения каждого",
    async (action) => {
      await withHistoryFixture(async (history, { db }) => {
        const parent = await history.start({ title: "Родитель приёмки" }, "родитель");
        const intent = await openHistoryIntent(history, parent);
        const first = await completedHistoryChild(history, history.get(parent.id), intent);
        const second = await completedHistoryChild(history, history.get(parent.id), intent);
        const current = history.get(parent.id);
        const reads = spyOn(db, "get");
        const batches = spyOn(db.commands, "load");
        const children = [second.id, first.id];
        let checkpoint: HistoryCheckpoint;
        try {
          checkpoint = await recordHistoryMaterial(history, current, intent, action, {
            acceptedSessionIds: children,
          });

          expect(reads.mock.calls.some(([ref]) => children.includes(ref))).toBe(false);
          const selections = batches.mock.calls.flatMap(([request]) => request.selectors);
          const acceptedReads = selections.filter(
            (selector) =>
              selector.kind === "records" && selector.ids.some((id) => children.includes(id)),
          );
          expect(acceptedReads).toEqual(
            action === "save"
              ? [{ kind: "records", ids: children, entityKind: "work-session" }]
              : [],
          );
          expect(
            selections.some(
              (selector) => selector.kind === "entity" && children.includes(selector.ref),
            ),
          ).toBe(false);
        } finally {
          batches.mockRestore();
          reads.mockRestore();
        }

        expect(checkpoint.data.acceptedSessionIds).toEqual(children);
        expect(checkpoint.data.sequence).toBe(2);
        expect(checkpoint.data.sessionRevision).toBe(current.revision + 1);
        expect(history.get(first.id)).toEqual(first);
        expect(history.get(second.id)).toEqual(second);
        expect(history.getCheckpoint(intent.id)).toEqual(intent);
      });
    },
  );

  test("закрытие намерения учитывает прежнюю приёмку и не требует закрытия ребёнка соседнего намерения", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const parent = await history.start({ title: "Два независимых намерения" }, "родитель");
      const intent = await openHistoryIntent(history, parent);
      const siblingIntent = await openHistoryIntent(
        history,
        history.get(parent.id),
        "Соседнее намерение",
      );
      const completed = await completedHistoryChild(history, history.get(parent.id), intent);
      const beforeFork = history.get(parent.id);
      const pending = await history.transition(
        siblingIntent.id,
        "fork",
        { title: "Ребёнок соседнего намерения", runId: currentHistoryRun(beforeFork).id },
        historyOwner(beforeFork),
      );
      const acceptance = await recordHistoryMaterial(
        history,
        history.get(parent.id),
        intent,
        "save",
        {
          acceptedSessionIds: [completed.id],
        },
      );
      const current = history.get(parent.id);

      const result = await expectLocalHistoryReads(
        db,
        async () => await recordHistoryMaterial(history, current, intent, "complete"),
      );

      expect(result.data).toMatchObject({ kind: "result", intentId: intent.id, sequence: 4 });
      expect(result.data.acceptedSessionIds).toEqual([]);
      expect(history.getCheckpoint(acceptance.id)).toEqual(acceptance);
      expect(history.get(completed.id)).toEqual(completed);
      expect(history.get(pending.id)).toEqual(pending);
      expect(history.intents(parent.id)).toEqual([siblingIntent]);
    });
  });

  test("ссылки на несколько целей читают содержание одним пакетом и сохраняют порядок снимков", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const knowledge = new KnowledgeService(db);
      const first = await knowledge.create(
        "document",
        { name: "Первый документ", body: "Первое основание материала." },
        "автор",
      );
      const second = await knowledge.create(
        "document",
        { name: "Второй документ", body: "Второе основание материала." },
        "автор",
      );
      const session = await history.start({ title: "Основания материала" }, "автор");
      const reads = spyOn(db, "get");
      const batches = spyOn(db.commands, "load");
      let intent: HistoryCheckpoint;
      try {
        intent = await history.checkpoint(
          session.id,
          "open",
          {
            runId: currentHistoryRun(session).id,
            title: "Сопоставить документы",
            body: "Сохранить основания.",
            references: [second.key, `document:${first.id}`],
          },
          historyOwner(session),
        );

        const selections = batches.mock.calls.flatMap(([request]) => request.selectors);
        expect(selections.filter((selector) => selector.kind === "records")).toEqual([
          { kind: "records", ids: [second.id, first.id] },
        ]);
        expect(
          selections.some(
            (selector) =>
              selector.kind === "entity" && [first.id, second.id].includes(selector.ref),
          ),
        ).toBe(false);
        expect(reads.mock.calls.some(([ref]) => ref === first.id || ref === second.id)).toBe(false);
      } finally {
        batches.mockRestore();
        reads.mockRestore();
      }

      expect(intent.data.references).toEqual([
        { id: second.id, kind: "document", key: second.key, title: "Второй документ" },
        { id: first.id, kind: "document", key: first.key, title: "Первый документ" },
      ]);
      expect(history.getCheckpoint(intent.id)).toEqual(intent);
    });
  });

  test("одинаковый save после записи другим соединением создаёт новый материал со свежим sequence", async () => {
    await withHistoryFixture(async (history, { connect }) => {
      const second = new HistoryService(connect());
      const session = await history.start({ title: "Продолжение без кеша снимков" }, "автор");
      const intent = await openHistoryIntent(history, session);
      const first = await recordHistoryMaterial(history, history.get(session.id), intent, "save");
      const other = await recordHistoryMaterial(second, second.get(session.id), intent, "save");

      const repeated = await recordHistoryMaterial(
        history,
        history.get(session.id),
        intent,
        "save",
      );

      expect(repeated.data.sequence).toBe(4);
      expect(repeated.data.sessionRevision).toBe(5);
      expect(new Set([first.id, other.id, repeated.id]).size).toBe(3);
      expect(repeated.data.body).toBe(first.data.body);
      expect(history.history(session.id)).toEqual([intent, first, other, repeated]);
      expect(second.get(session.id).revision).toBe(5);
    });
  });

  test("ошибочный sessionId существующего результата не скрывает закрытие исходного intent", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const session = await history.start({ title: "Владелец намерения" }, "автор");
      const intent = await openHistoryIntent(history, session);
      const foreign = await history.start({ title: "Ошибочная сессия результата" }, "автор");
      const id = crypto.randomUUID();
      // Повреждаем только связь результата с сессией; намерение по-прежнему явно указано.
      db.insert({
        ...intent,
        id,
        key: `CP-${id}`,
        data: {
          ...intent.data,
          kind: "result",
          sessionId: foreign.id,
          runId: currentHistoryRun(foreign).id,
          intentId: intent.id,
        },
      });
      const current = history.get(session.id);
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(
        async () => await recordHistoryMaterial(history, current, intent, "save"),
        "CONFLICT",
      );

      expect(snapshotHistoryStorage(db)).toEqual(before);
      expect(history.getCheckpoint(intent.id)).toEqual(intent);
    });
  });

  test.each(corruptedChildLinks)(
    "повреждённый %s ребёнка не скрывает его при закрытии намерения",
    async (field) => {
      await withHistoryFixture(async (history, { db }) => {
        const session = await history.start({ title: "Родитель повреждённой связи" }, "автор");
        const intent = await openHistoryIntent(history, session);
        const child = await forkHistorySession(history, history.get(session.id), intent);
        // Одна сторона происхождения остаётся валидной и должна привести к повреждённому ребёнку.
        db.update(
          { ...child, revision: child.revision + 1, data: { ...child.data, [field]: null } },
          child.revision,
        );
        const current = history.get(session.id);
        const before = snapshotHistoryStorage(db);

        await expectHistoryError(
          async () => await recordHistoryMaterial(history, current, intent, "complete"),
          "CORRUPT_DATA",
        );

        expect(snapshotHistoryStorage(db)).toEqual(before);
      });
    },
  );

  test("UUID завершённого участия чужой сессии остаётся занят без загрузки её содержания", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const session = await history.start({ title: "Выдать ID материала" }, "автор");
      const collision = crypto.randomUUID();
      const available = crypto.randomUUID();
      const foreign = await withHistoryIds(
        [collision],
        async () => await history.start({ title: foreignMarker }, "другой-автор"),
      );
      const paused = await history.transition(
        foreign.id,
        "pause",
        { runId: currentHistoryRun(foreign).id, reason: "Закончить участие" },
        historyOwner(foreign),
      );

      const intent = await withHistoryIds(
        [collision, available],
        async () =>
          await expectLocalHistoryReads(db, async () => await openHistoryIntent(history, session)),
      );

      expect(currentHistoryRun(foreign).id).toBe(collision);
      expect(paused.data.currentRunId).toBeNull();
      expect(intent.id).toBe(available);
      expect(intent.data.sequence).toBe(1);
      expect(history.get(foreign.id)).toEqual(paused);
      expect(history.getCheckpoint(intent.id)).toEqual(intent);
    });
  });

  test.each(addressPrefixes)(
    "занятый алиас %s<UUID> отклоняет кандидат ID без чтения чужой карточки",
    async (prefix) => {
      await withHistoryFixture(async (history, { db }) => {
        const session = await history.start({ title: "Адреса нового материала" }, "автор");
        const collision = crypto.randomUUID();
        const available = crypto.randomUUID();
        const knowledge = new KnowledgeService(db);
        const document = await knowledge.create(
          "document",
          { name: foreignMarker, body: "Содержание цели занятого адреса." },
          "автор",
        );
        const renamed = await knowledge.rename("document", document.id, `${prefix}${collision}`, {
          actor: "автор",
          ifRevision: document.revision,
        });
        const current = await knowledge.rename("document", document.id, "DOC-OTHER", {
          actor: "автор",
          ifRevision: renamed.revision,
        });

        const intent = await withHistoryIds(
          [collision, available],
          async () =>
            await expectLocalHistoryReads(
              db,
              async () => await openHistoryIntent(history, session),
            ),
        );

        expect(intent.id).toBe(available);
        expect(intent.key).toBe(`CP-${available}`);
        expect(db.getIdentity(`${prefix}${collision}`)?.id).toBe(document.id);
        expect(knowledge.get("document", document.id)).toEqual(current);
      });
    },
  );
});
