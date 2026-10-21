import { parentPort, workerData } from "node:worker_threads";
import { RelayError, type EntityRecord } from "@relay/contracts";
import { ProjectDatabase } from "../../src/database/project-database";
import type {
  ConcurrentWriterInput,
  ConcurrentWriterResult,
} from "./helpers/concurrent-writer.types";

/**
 * Проверяет внешние параметры worker до открытия принадлежащего ему соединения.
 */
function readWriterInput(input: unknown): ConcurrentWriterInput {
  if (
    input === null ||
    typeof input !== "object" ||
    !("path" in input) ||
    typeof input.path !== "string" ||
    !("actor" in input) ||
    typeof input.actor !== "string"
  ) {
    throw new Error("Писателю необходимы путь базы и автор");
  }
  return { path: input.path, actor: input.actor };
}

/**
 * Записывает шесть документов с атомарным выделением номера и пытается обновить общую ревизию.
 * Только ожидаемый конфликт CAS считается результатом; остальные ошибки завершают worker с отказом.
 */
function writeConcurrentChanges(
  db: ProjectDatabase,
  original: EntityRecord,
  actor: string,
): ConcurrentWriterResult {
  const keys: string[] = [];
  for (let index = 0; index < 6; index++) {
    keys.push(
      db.transaction(() => {
        const key = db.nextKey("DOC");
        const now = new Date().toISOString();
        db.insert({
          id: crypto.randomUUID(),
          kind: "document",
          key,
          revision: 1,
          createdAt: now,
          updatedAt: now,
          createdBy: actor,
          updatedBy: actor,
          data: { index },
        });
        return key;
      }),
    );
  }
  try {
    db.update(
      { ...original, revision: original.revision + 1, updatedBy: actor, data: { actor } },
      original.revision,
    );
    return { keys, outcome: "updated" };
  } catch (error) {
    if (!(error instanceof RelayError) || error.code !== "REVISION_CONFLICT") {
      throw error;
    }
    return { keys, outcome: "REVISION_CONFLICT" };
  }
}

const { path, actor } = readWriterInput(workerData);
const port = parentPort;
if (!port) {
  throw new Error("Конкурентный писатель должен запускаться внутри worker");
}
const db = ProjectDatabase.open(path);
try {
  const original = db.get("PRODUCT");
  if (!original) {
    throw new Error("Начальный паспорт отсутствует в тестовой базе");
  }
  // Оба писателя читают одну ревизию до разрешения на запись от теста.
  port.postMessage({ type: "ready" });
  port.once("message", () => {
    try {
      port.postMessage({ type: "result", ...writeConcurrentChanges(db, original, actor) });
    } finally {
      db.close();
      port.close();
    }
  });
} catch (error) {
  db.close();
  port.close();
  throw error;
}
