import { parentPort, workerData } from "node:worker_threads";
import type { EntityRecord } from "@relay/contracts";
import { ProjectDatabase } from "../../src";

const { path, actor } = workerData as { path: string; actor: string };
const db = ProjectDatabase.open(path);
const original = db.get("PRODUCT")!;

// Оба писателя читают одну ревизию до разрешения на запись от теста.
parentPort!.postMessage({ type: "ready" });
parentPort!.once("message", () => {
  try {
    const keys: string[] = [];
    for (let index = 0; index < 6; index++) {
      keys.push(
        db.transaction(() => {
          const key = db.nextKey("DOC");
          const now = new Date().toISOString();
          const entity: EntityRecord = {
            id: crypto.randomUUID(),
            kind: "document",
            key,
            revision: 1,
            createdAt: now,
            updatedAt: now,
            createdBy: actor,
            updatedBy: actor,
            data: { index },
          };
          db.insert(entity);
          return key;
        }),
      );
    }
    let outcome = "updated";
    try {
      db.update(
        { ...original, revision: original.revision + 1, updatedBy: actor, data: { actor } },
        original.revision,
      );
    } catch (error) {
      outcome = (error as { code: string }).code;
    }
    parentPort!.postMessage({ type: "result", keys, outcome });
  } finally {
    db.close();
    parentPort!.close();
  }
});
