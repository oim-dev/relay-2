import { describe, expect, test } from "bun:test";
import { ProjectDatabaseFixture } from "./helpers/project-database-fixture";
import { startConcurrentWriter } from "./helpers/concurrent-writer";
import type { ConcurrentWriterHandle } from "./helpers/concurrent-writer.types";

const actors = ["first", "second"] as const;

describe("Конкурентные писатели файловой базы", () => {
  test("параллельные писатели получают разные номера и лишь один выигрывает CAS", async () => {
    const fixture = new ProjectDatabaseFixture("writers");
    const writers: ConcurrentWriterHandle[] = [];
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const db = fixture.create();
      const generation = db.getGeneration();
      for (const actor of actors) {
        writers.push(startConcurrentWriter(fixture.path, actor));
      }
      const completed = Promise.all(writers.map((writer) => writer.result));
      const ready = Promise.all(writers.map((writer) => writer.ready));
      const deadline = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Писатели не завершились за 4 секунды")), 4000);
      });
      await Promise.race([ready, completed, deadline]);

      for (const writer of writers) {
        writer.worker.postMessage("write");
      }
      const written = await Promise.race([completed, deadline]);

      expect(new Set(written.flatMap((result) => result.keys)).size).toBe(12);
      const documents = db.list("document");
      expect(documents).toHaveLength(12);
      for (const [writerIndex, result] of written.entries()) {
        const actor = actors[writerIndex];
        expect(result.keys).toHaveLength(6);
        for (const [index, key] of result.keys.entries()) {
          expect(documents.find((document) => document.key === key)).toMatchObject({
            revision: 1,
            createdBy: actor,
            updatedBy: actor,
            data: { name: `${actor}-${index + 1}`, body: `Запись ${actor}` },
          });
        }
      }
      expect(db.nextKey("DOC")).toBe("DOC-13");
      expect(written.map((result) => result.outcome).sort()).toEqual([
        "REVISION_CONFLICT",
        "updated",
      ]);
      const winner = actors[written.findIndex((result) => result.outcome === "updated")];
      expect(db.get("PRODUCT", "product")).toMatchObject({
        revision: 2,
        updatedBy: winner,
        data: { name: winner },
      });
      expect(db.getGeneration()).toBe(generation + 13);
    } finally {
      clearTimeout(timeout);
      await Promise.all(writers.map((writer) => writer.worker.terminate()));
      fixture.close();
    }
  });
});
