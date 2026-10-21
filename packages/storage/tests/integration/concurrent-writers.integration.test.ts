import { describe, expect, test } from "bun:test";
import { ProjectDatabaseFixture } from "./helpers/project-database-fixture";
import { startConcurrentWriter } from "./helpers/concurrent-writer";
import type { ConcurrentWriterHandle } from "./helpers/concurrent-writer.types";

describe("Конкурентные писатели файловой базы", () => {
  test("параллельные писатели получают разные номера и лишь один выигрывает CAS", async () => {
    const fixture = new ProjectDatabaseFixture("writers");
    const writers: ConcurrentWriterHandle[] = [];
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const db = fixture.create();
      const generation = db.getGeneration();
      for (const actor of ["first", "second"]) {
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
      expect(db.list("document")).toHaveLength(12);
      expect(db.nextKey("DOC")).toBe("DOC-13");
      expect(written.map((result) => result.outcome).sort()).toEqual([
        "REVISION_CONFLICT",
        "updated",
      ]);
      expect(db.get("PRODUCT")?.revision).toBe(2);
      expect(db.getGeneration()).toBe(generation + 13);
    } finally {
      clearTimeout(timeout);
      await Promise.all(writers.map((writer) => writer.worker.terminate()));
      fixture.close();
    }
  });
});
