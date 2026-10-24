import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { ProjectDatabase } from "@relay/storage";

/**
 * Удерживает две реальные SQLite connections до завершения async проверки и удаляет свой fixture.
 */
export async function withCommandExecutorDatabase(
  run: (database: ProjectDatabase, competitor: ProjectDatabase) => Promise<void>,
): Promise<void> {
  const root = resolve(
    import.meta.dir,
    "../../../../../.artifacts",
    new Date().toISOString().slice(0, 10),
    "git-sync-implementation/commands/fixtures",
  );
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "executor-"));
  let database: ProjectDatabase | undefined;
  let competitor: ProjectDatabase | undefined;
  try {
    database = ProjectDatabase.create(join(directory, "project.sqlite"), {
      id: crypto.randomUUID(),
      name: "Асинхронные команды",
      slug: "async-command",
    });
    competitor = ProjectDatabase.open(database.path);
    await run(database, competitor);
  } finally {
    competitor?.close();
    database?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
