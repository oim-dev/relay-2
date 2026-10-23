import { describe, expect, spyOn, test } from "bun:test";
import type { HistoryCheckpoint, HistorySession } from "@relay/contracts";
import type { ProjectDatabase } from "@relay/storage";
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
function expectLocalHistoryReads<T>(db: ProjectDatabase, operation: () => T): T {
  const fullReads = spyOn(db, "list");
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
    const result = operation();

    expect(fullReads).not.toHaveBeenCalled();
    expect(foreignJson).toEqual([]);
    return result;
  } finally {
    decoder.mockRestore();
    fullReads.mockRestore();
  }
}

/**
 * Подставляет UUID для первых выделений в синхронном сценарии, затем использует исходный генератор.
 * Нужен для воспроизводимой коллизии настоящих записей; глобальный генератор восстанавливается.
 */
function withHistoryIds<T>(
  ids: readonly ReturnType<Crypto["randomUUID"]>[],
  operation: () => T,
): T {
  /**
   * Сохраняет штатный генератор для выделений после заданных тестом коллизий.
   */
  const original: Crypto["randomUUID"] = crypto.randomUUID.bind(crypto);
  let index = 0;
  const generator = spyOn(crypto, "randomUUID").mockImplementation(
    () => ids[index++] ?? original(),
  );
  try {
    return operation();
  } finally {
    generator.mockRestore();
  }
}

/**
 * Создаёт и завершает прямого ребёнка без собственных материалов через публичные переходы.
 * Ревизия родителя передаётся явно; ребёнок остаётся непринятым исходным намерением.
 */
function completedHistoryChild(
  history: HistoryService,
  parent: HistorySession,
  intent: HistoryCheckpoint,
): HistorySession {
  const child = forkHistorySession(history, parent, intent);
  const attached = history.transition(
    child.id,
    "attach",
    {},
    { actor: "исполнитель-ребёнка", ifRevision: child.revision },
  );
  return completeHistorySession(history, attached);
}

describe("Ограниченные чтения записи checkpoint", () => {
  test.each(checkpointActions)(
    "$action не загружает чужую историю ради sequence и ID",
    ({ action, kind }) => {
      withHistoryFixture((history, { db }) => {
        const session = history.start({ title: "Выбранная сессия" }, "автор");
        const intent = openHistoryIntent(history, session);
        const foreign = history.start({ title: foreignMarker }, "другой-автор");
        const foreignIntent = openHistoryIntent(history, foreign, foreignMarker);
        const foreignProgress = recordHistoryMaterial(
          history,
          history.get(foreign.id),
          foreignIntent,
          "save",
        );
        const foreignSession = history.get(foreign.id);
        const current = history.get(session.id);
        const generation = db.getGeneration();

        const checkpoint = expectLocalHistoryReads(db, () =>
          history.checkpoint(
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
    (action) => {
      withHistoryFixture((history, { db }) => {
        const parent = history.start({ title: "Родитель приёмки" }, "родитель");
        const intent = openHistoryIntent(history, parent);
        const first = completedHistoryChild(history, history.get(parent.id), intent);
        const second = completedHistoryChild(history, history.get(parent.id), intent);
        const current = history.get(parent.id);
        const reads = spyOn(db, "get");
        const batches = spyOn(db, "getMany");
        const children = [second.id, first.id];
        let checkpoint: HistoryCheckpoint;
        try {
          checkpoint = expectLocalHistoryReads(db, () =>
            recordHistoryMaterial(history, current, intent, action, {
              acceptedSessionIds: children,
            }),
          );

          expect(reads.mock.calls.some(([ref]) => children.includes(ref))).toBe(false);
          if (action === "save") {
            expect(batches).toHaveBeenCalledTimes(1);
            expect(batches).toHaveBeenCalledWith(children, "work-session");
          } else {
            expect(batches).not.toHaveBeenCalled();
          }
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

  test("закрытие намерения учитывает прежнюю приёмку и не требует закрытия ребёнка соседнего намерения", () => {
    withHistoryFixture((history, { db }) => {
      const parent = history.start({ title: "Два независимых намерения" }, "родитель");
      const intent = openHistoryIntent(history, parent);
      const siblingIntent = openHistoryIntent(
        history,
        history.get(parent.id),
        "Соседнее намерение",
      );
      const completed = completedHistoryChild(history, history.get(parent.id), intent);
      const beforeFork = history.get(parent.id);
      const pending = history.transition(
        siblingIntent.id,
        "fork",
        { title: "Ребёнок соседнего намерения", runId: currentHistoryRun(beforeFork).id },
        historyOwner(beforeFork),
      );
      const acceptance = recordHistoryMaterial(history, history.get(parent.id), intent, "save", {
        acceptedSessionIds: [completed.id],
      });
      const current = history.get(parent.id);

      const result = expectLocalHistoryReads(db, () =>
        recordHistoryMaterial(history, current, intent, "complete"),
      );

      expect(result.data).toMatchObject({ kind: "result", intentId: intent.id, sequence: 4 });
      expect(result.data.acceptedSessionIds).toEqual([]);
      expect(history.getCheckpoint(acceptance.id)).toEqual(acceptance);
      expect(history.get(completed.id)).toEqual(completed);
      expect(history.get(pending.id)).toEqual(pending);
      expect(history.intents(parent.id)).toEqual([siblingIntent]);
    });
  });

  test("ссылки на несколько целей читают содержание одним пакетом и сохраняют порядок снимков", () => {
    withHistoryFixture((history, { db }) => {
      const knowledge = new KnowledgeService(db);
      const first = knowledge.create(
        "document",
        { name: "Первый документ", body: "Первое основание материала." },
        "автор",
      );
      const second = knowledge.create(
        "document",
        { name: "Второй документ", body: "Второе основание материала." },
        "автор",
      );
      const session = history.start({ title: "Основания материала" }, "автор");
      const reads = spyOn(db, "get");
      const batches = spyOn(db, "getMany");
      let intent: HistoryCheckpoint;
      try {
        intent = history.checkpoint(
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

        expect(batches).toHaveBeenCalledTimes(1);
        expect(batches).toHaveBeenCalledWith([second.id, first.id]);
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

  test("одинаковый save после записи другим соединением создаёт новый материал со свежим sequence", () => {
    withHistoryFixture((history, { connect }) => {
      const second = new HistoryService(connect());
      const session = history.start({ title: "Продолжение без кеша снимков" }, "автор");
      const intent = openHistoryIntent(history, session);
      const first = recordHistoryMaterial(history, history.get(session.id), intent, "save");
      const other = recordHistoryMaterial(second, second.get(session.id), intent, "save");

      const repeated = recordHistoryMaterial(history, history.get(session.id), intent, "save");

      expect(repeated.data.sequence).toBe(4);
      expect(repeated.data.sessionRevision).toBe(5);
      expect(new Set([first.id, other.id, repeated.id]).size).toBe(3);
      expect(repeated.data.body).toBe(first.data.body);
      expect(history.history(session.id)).toEqual([intent, first, other, repeated]);
      expect(second.get(session.id).revision).toBe(5);
    });
  });

  test("ошибочный sessionId существующего результата не скрывает закрытие исходного intent", () => {
    withHistoryFixture((history, { db }) => {
      const session = history.start({ title: "Владелец намерения" }, "автор");
      const intent = openHistoryIntent(history, session);
      const foreign = history.start({ title: "Ошибочная сессия результата" }, "автор");
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

      expectHistoryError(() => recordHistoryMaterial(history, current, intent, "save"), "CONFLICT");

      expect(snapshotHistoryStorage(db)).toEqual(before);
      expect(history.getCheckpoint(intent.id)).toEqual(intent);
    });
  });

  test.each(corruptedChildLinks)(
    "повреждённый %s ребёнка не скрывает его при закрытии намерения",
    (field) => {
      withHistoryFixture((history, { db }) => {
        const session = history.start({ title: "Родитель повреждённой связи" }, "автор");
        const intent = openHistoryIntent(history, session);
        const child = forkHistorySession(history, history.get(session.id), intent);
        // Одна сторона происхождения остаётся валидной и должна привести к повреждённому ребёнку.
        db.update(
          { ...child, revision: child.revision + 1, data: { ...child.data, [field]: null } },
          child.revision,
        );
        const current = history.get(session.id);
        const before = snapshotHistoryStorage(db);

        expectHistoryError(
          () => recordHistoryMaterial(history, current, intent, "complete"),
          "CORRUPT_DATA",
        );

        expect(snapshotHistoryStorage(db)).toEqual(before);
      });
    },
  );

  test("UUID завершённого участия чужой сессии остаётся занят без загрузки её содержания", () => {
    withHistoryFixture((history, { db }) => {
      const session = history.start({ title: "Выдать ID материала" }, "автор");
      const collision = crypto.randomUUID();
      const available = crypto.randomUUID();
      const foreign = withHistoryIds([collision], () =>
        history.start({ title: foreignMarker }, "другой-автор"),
      );
      const paused = history.transition(
        foreign.id,
        "pause",
        { runId: currentHistoryRun(foreign).id, reason: "Закончить участие" },
        historyOwner(foreign),
      );

      const intent = withHistoryIds([collision, available], () =>
        expectLocalHistoryReads(db, () => openHistoryIntent(history, session)),
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
    (prefix) => {
      withHistoryFixture((history, { db }) => {
        const session = history.start({ title: "Адреса нового материала" }, "автор");
        const collision = crypto.randomUUID();
        const available = crypto.randomUUID();
        const knowledge = new KnowledgeService(db);
        const document = knowledge.create(
          "document",
          { name: foreignMarker, body: "Содержание цели занятого адреса." },
          "автор",
        );
        const renamed = knowledge.rename("document", document.id, `${prefix}${collision}`, {
          actor: "автор",
          ifRevision: document.revision,
        });
        const current = knowledge.rename("document", document.id, "DOC-OTHER", {
          actor: "автор",
          ifRevision: renamed.revision,
        });

        const intent = withHistoryIds([collision, available], () =>
          expectLocalHistoryReads(db, () => openHistoryIntent(history, session)),
        );

        expect(intent.id).toBe(available);
        expect(intent.key).toBe(`CP-${available}`);
        expect(db.getIdentity(`${prefix}${collision}`)?.id).toBe(document.id);
        expect(knowledge.get("document", document.id)).toEqual(current);
      });
    },
  );
});
