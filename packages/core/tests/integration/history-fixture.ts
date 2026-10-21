import { expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  RelayError,
  type EntityRecord,
  type HistoryCheckpoint,
  type HistoryCheckpointAction,
  type HistoryRun,
  type HistorySession,
  type WriteOptions,
} from "@relay/contracts";
import { ProjectDatabase } from "@relay/storage";
import { HistoryService } from "../../src/history/history";
import type {
  HistoryDatabaseFixture,
  HistoryMaterialReferences,
  HistoryStorageSnapshot,
} from "./history-fixture.types";

/**
 * Создаёт пустую файловую SQLite и сервис истории для синхронного теста.
 * Дополнительные соединения независимы; все соединения и каталог удаляются даже при отказе.
 * Предметные сессии и материалы создаёт сам тест, встроенных утверждений нет.
 */
export function withHistoryFixture(
  operation: (history: HistoryService, database: HistoryDatabaseFixture) => void,
): void {
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
    operation(new HistoryService(db), {
      db,
      path,
      /**
       * Открывает ещё одно соединение и передаёт владение им fixture.
       */
      connect(): ProjectDatabase {
        const connection = ProjectDatabase.open(path);
        connections.push(connection);
        return connection;
      },
    });
  } finally {
    for (const connection of connections) {
      connection.close();
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Возвращает активное участие переданного снимка сессии без перечитывания БД.
 * Отсутствие владельца означает ошибку подготовки теста, а не повод выбрать другой run.
 */
export function currentHistoryRun(session: HistorySession): HistoryRun {
  const run = session.data.runs.find((entry) => entry.id === session.data.currentRunId);
  if (run === undefined || run.state !== "active") {
    throw new Error("Подготовленная сессия должна иметь активное участие.");
  }
  return run;
}

/**
 * Фиксирует автора и исходную ревизию переданного снимка; свежую ревизию не подставляет.
 */
export function historyOwner(session: HistorySession): WriteOptions {
  return { actor: currentHistoryRun(session).actor, ifRevision: session.revision };
}

/**
 * Открывает намерение с минимальным содержанием по участию и ревизии переданной сессии.
 * Сервис атомарно добавляет материал и повышает ревизию сессии; её снимок остаётся прежним.
 */
export function openHistoryIntent(
  history: HistoryService,
  session: HistorySession,
  title = "Исследовать контракт",
): HistoryCheckpoint {
  return history.checkpoint(
    session.key,
    "open",
    {
      title,
      body: "Сопоставить поведение с предметными правилами.",
      runId: currentHistoryRun(session).id,
    },
    historyOwner(session),
  );
}

/**
 * Добавляет продолжение указанного намерения с явно переданным снимком владельца.
 * Дополнения задают ссылки и приёмку; скрытого чтения или обновления ревизии нет.
 * Успех сервиса изменяет сессию и добавляет материал, не переписывая исходный intent.
 */
export function recordHistoryMaterial(
  history: HistoryService,
  session: HistorySession,
  intent: HistoryCheckpoint,
  action: Exclude<HistoryCheckpointAction, "open">,
  references: HistoryMaterialReferences = {},
): HistoryCheckpoint {
  return history.checkpoint(
    intent.id,
    action,
    {
      title: "Проверен контракт истории",
      body: "Проверены условия сохранения материалов и закрытия работы.",
      runId: currentHistoryRun(session).id,
      ...references,
    },
    historyOwner(session),
  );
}

/**
 * Создаёт pending-ребёнка исходного намерения по ревизии и участию переданного родителя.
 * Родительская ревизия повышается вместе со вставкой ребёнка; ребёнок ещё не имеет run.
 */
export function forkHistorySession(
  history: HistoryService,
  parent: HistorySession,
  intent: HistoryCheckpoint,
): HistorySession {
  return history.transition(
    intent.key,
    "fork",
    {
      title: "Проверить отдельный сценарий",
      description: "Проверить результат и приложить основания.",
      runId: currentHistoryRun(parent).id,
    },
    historyOwner(parent),
  );
}

/**
 * Завершает сессию по переданному снимку владельца с содержательным результатом.
 * Закрытие намерений и дочерних работ остаётся явной подготовкой теста.
 */
export function completeHistorySession(
  history: HistoryService,
  session: HistorySession,
): HistorySession {
  return history.transition(
    session.id,
    "complete",
    { runId: currentHistoryRun(session).id, result: "Проверка завершена, результат сохранён." },
    historyOwner(session),
  );
}

/**
 * Проверяет тип и предметный код синхронного отказа, возвращая ошибку для проверки деталей.
 * Успешный вызов или постороннее исключение всегда проваливают тест.
 */
export function expectHistoryError(operation: () => unknown, code: RelayError["code"]): RelayError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(RelayError);
    if (!(error instanceof RelayError)) {
      throw error;
    }
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`Ожидалась ошибка ${code}.`);
}

/**
 * Читает строки истории и поколение одним снимком, включая намеренно повреждённые записи.
 * Сравнение снимков проверяет отсутствие частичной записи, смены ревизий и потери материалов.
 */
export function snapshotHistoryStorage(db: ProjectDatabase): HistoryStorageSnapshot {
  return db.snapshot(() => {
    return {
      sessions: db.list("work-session"),
      checkpoints: db.list("work-checkpoint"),
      generation: db.getGeneration(),
    };
  });
}

/**
 * Намеренно заменяет обязательный массив участия на null через Storage.
 * Возвращает повреждённую строку; валидное состояние таким способом не подготавливается.
 */
export function corruptHistoryRuns(db: ProjectDatabase, session: HistorySession): EntityRecord {
  const corrupted = {
    ...session,
    revision: session.revision + 1,
    data: { ...session.data, runs: null },
  };
  db.update(corrupted, session.revision);
  return corrupted;
}

/**
 * Вставляет отдельный намеренно повреждённый материал с references: null через Storage.
 * Исходное валидное намерение сохраняется, чтобы отказ продолжения проверял всю историю.
 */
export function insertCorruptedHistoryCheckpoint(
  db: ProjectDatabase,
  intent: HistoryCheckpoint,
): EntityRecord {
  const id = crypto.randomUUID();
  const corrupted = {
    ...intent,
    id,
    key: `CP-${id}`,
    data: { ...intent.data, references: null },
  };
  db.insert(corrupted);
  return corrupted;
}

/**
 * Внедряет отказ SQLite при обновлении сессии после вставки материала или ребёнка.
 * Триггер удаляется и техническое соединение закрывается при любом исходе callback.
 * Встроенных проверок нет: ожидаемый отказ и состояние отката утверждает сам тест.
 */
export function withHistorySessionUpdateFailure(path: string, operation: () => void): void {
  const connection = new Database(path, { create: false, readwrite: true });
  try {
    connection.exec(`
      CREATE TRIGGER history_fail_session BEFORE UPDATE ON entities
      WHEN OLD.kind = 'work-session'
      BEGIN SELECT RAISE(ABORT, 'Проверка отката составной записи'); END;
    `);
    try {
      operation();
    } finally {
      connection.exec("DROP TRIGGER history_fail_session");
    }
  } finally {
    connection.close();
  }
}
