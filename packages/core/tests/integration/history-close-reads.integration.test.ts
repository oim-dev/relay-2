import { describe, expect, spyOn, test } from "bun:test";
import type { HistoryCheckpoint, HistorySession } from "@relay/contracts";
import type { HistoryService } from "../../src/history/history";
import {
  currentHistoryRun,
  expectHistoryError,
  historyOwner,
  openHistoryIntent,
  recordHistoryMaterial,
  snapshotHistoryStorage,
  withHistoryFixture,
} from "./history-fixture";

const closureCases = [
  { name: "complete трёх намерений", action: "complete", intentCount: 3 },
  { name: "cancel трёх намерений", action: "cancel", intentCount: 3 },
  { name: "complete без намерений", action: "complete", intentCount: 0 },
] as const;
const foreignPhantoms = [
  {
    name: "продолжение intent с чужим sessionId",
    entityKind: "work-checkpoint",
    field: "intentId",
  },
  {
    name: "ребёнок intent с чужим parentSessionId",
    entityKind: "work-session",
    field: "originCheckpointId",
  },
] as const;

/**
 * Создаёт только необходимые закрытые намерения публичными командами.
 * Ревизия читается явно перед каждым новым шагом; соединением владеет вызывающий fixture.
 */
async function createClosedHistoryIntents(
  history: HistoryService,
  session: HistorySession,
  count: number,
): Promise<HistoryCheckpoint[]> {
  const intents: HistoryCheckpoint[] = [];
  for (let index = 0; index < count; index++) {
    const intent = await openHistoryIntent(
      history,
      history.get(session.id),
      `Намерение ${index + 1}`,
    );
    await recordHistoryMaterial(history, history.get(session.id), intent, "complete");
    intents.push(intent);
  }
  return intents;
}

describe("Пакетные основания закрытия сессии", () => {
  test.each(closureCases)(
    "$name требует не более четырёх field loads и guards",
    async ({ action, intentCount }) => {
      await withHistoryFixture(async (history, { db }) => {
        const session = await history.start({ title: "Ограниченные выборки закрытия" }, "автор");
        const intents = await createClosedHistoryIntents(history, session, intentCount);
        const owner = history.get(session.id);
        const materials = history.history(session.id);
        const values = intents.map((intent) => intent.id).sort();
        const expected = [
          { kind: "field", entityKind: "work-checkpoint", field: "sessionId", value: session.id },
          {
            kind: "field",
            entityKind: "work-session",
            field: "parentSessionId",
            value: session.id,
          },
          ...(values.length === 0
            ? []
            : [
                { kind: "field-set", entityKind: "work-checkpoint", field: "intentId", values },
                {
                  kind: "field-set",
                  entityKind: "work-session",
                  field: "originCheckpointId",
                  values,
                },
              ]),
        ];
        const loads = spyOn(db.commands, "load");
        const commits = spyOn(db.commands, "commit");
        try {
          const result = await history.transition(
            session.id,
            action,
            {
              runId: currentHistoryRun(owner).id,
              result: "Все намерения закрыты",
            },
            historyOwner(owner),
          );

          const selectors = loads.mock.calls.flatMap(([request]) => request.selectors);
          const fieldLoads = selectors.filter(
            (selector) => selector.kind === "field" || selector.kind === "field-set",
          );
          expect(fieldLoads).toHaveLength(expected.length);
          expect(fieldLoads).toEqual(expect.arrayContaining(expected));
          expect(selectors.some((selector) => selector.kind === "kind")).toBe(false);
          expect(commits).toHaveBeenCalledTimes(1);
          const fieldGuards = commits.mock.calls[0]?.[0].guards
            .map((guard) => guard.selector)
            .filter((selector) => selector.kind === "field" || selector.kind === "field-set");
          expect(fieldGuards).toHaveLength(expected.length);
          expect(fieldGuards).toEqual(expect.arrayContaining(expected));
          expect(result.data.status).toBe(action === "complete" ? "completed" : "cancelled");
          expect(result.revision).toBe(owner.revision + 1);
          expect(history.get(session.id)).toEqual(result);
          expect(history.history(session.id)).toEqual(materials);
        } finally {
          commits.mockRestore();
          loads.mockRestore();
        }
      });
    },
  );

  test.each(foreignPhantoms)(
    "поздняя вставка: $name нарушает set guard и не скрывается при новом чтении",
    async ({ entityKind, field }) => {
      await withHistoryFixture(async (history, { db, connect }) => {
        const session = await history.start({ title: "Владелец закрываемых намерений" }, "автор");
        const intents = await createClosedHistoryIntents(history, session, 3);
        const foreign = await history.start({ title: "Чужая сессия" }, "автор");
        const intent = intents[1];
        if (intent === undefined) {
          throw new Error("Не подготовлено второе намерение");
        }
        const owner = history.get(session.id);
        const second = connect();
        const ready = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const commit = db.commands.commit.bind(db.commands);
        const barrier = spyOn(db.commands, "commit").mockImplementationOnce(async (plan) => {
          ready.resolve();
          await release.promise;
          return commit(plan);
        });
        const input = { runId: currentHistoryRun(owner).id, result: "Подготовленное закрытие" };
        const pending = history.transition(session.id, "complete", input, historyOwner(owner));
        // Ошибка подготовки тоже освобождает ожидание: дефект не превращается в зависший тест.
        void pending.catch((error: unknown) => ready.reject(error));
        try {
          await ready.promise;
          const id = crypto.randomUUID();
          // Техническая вставка намеренно повреждает одну из связей и не меняет CAS выбранного владельца.
          if (entityKind === "work-checkpoint") {
            second.insert({
              ...intent,
              id,
              key: `CP-${id}`,
              data: {
                ...intent.data,
                kind: "progress",
                sessionId: foreign.id,
                runId: currentHistoryRun(foreign).id,
                intentId: intent.id,
                sequence: 1,
              },
            });
          } else {
            second.insert({
              ...foreign,
              id,
              key: `S-${id}`,
              data: {
                ...foreign.data,
                status: "pending",
                currentRunId: null,
                runs: [],
                parentSessionId: foreign.id,
                originCheckpointId: intent.id,
                createdByRunId: currentHistoryRun(foreign).id,
              },
            });
          }
          const before = snapshotHistoryStorage(db);
          const outbox = db.getReplicationOutbox();
          release.resolve();

          const error = await expectHistoryError(() => pending, "COMMAND_CONTEXT_CHANGED");

          expect(error.details).toMatchObject({
            selector: {
              kind: "field-set",
              entityKind,
              field,
              values: intents.map((entry) => entry.id).sort(),
            },
          });
          expect(barrier).toHaveBeenCalledTimes(1);
          expect(snapshotHistoryStorage(db)).toEqual(before);
          expect(db.getReplicationOutbox()).toEqual(outbox);
          expect(history.get(session.id)).toEqual(owner);

          await expectHistoryError(
            () => history.transition(session.id, "complete", input, historyOwner(owner)),
            "CONFLICT",
          );

          expect(snapshotHistoryStorage(db)).toEqual(before);
          expect(db.getReplicationOutbox()).toEqual(outbox);
        } finally {
          release.resolve();
          await pending.catch(() => {});
          barrier.mockRestore();
        }
      });
    },
  );
});
