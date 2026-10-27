import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { ProjectDatabase } from "@relay/storage";

/**
 * Владеет отдельной файловой БД проекций; пользовательские данные и процессы не используются.
 */
export async function withGraphViewFixture(
  operation: (db: ProjectDatabase) => Promise<void>,
): Promise<void> {
  const parent = resolve(
    import.meta.dir,
    "../../../../.artifacts",
    new Date().toISOString().slice(0, 10),
    "graph-view-fixtures",
  );
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, "graph-view-test-"));
  const db = ProjectDatabase.create(join(directory, "project.sqlite"), {
    id: crypto.randomUUID(),
    name: "Проекции",
    slug: "views",
  });
  try {
    await operation(db);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
