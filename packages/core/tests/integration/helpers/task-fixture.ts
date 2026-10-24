import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { ProjectDatabase } from "@relay/storage";

/**
 * Передаёт два настоящих соединения одной изолированной SQLite и ждёт завершения callback.
 * Владеет обоими соединениями и каталогом; очистка выполняется также при async отказе.
 */
export async function withTaskConnections(
  run: (db: ProjectDatabase, peer: ProjectDatabase) => Promise<void>,
): Promise<void> {
  const artifacts = resolve(
    import.meta.dir,
    "../../../../../.artifacts",
    new Date().toISOString().slice(0, 10),
    "git-sync-implementation/commands/tasks",
  );
  mkdirSync(artifacts, { recursive: true });
  const directory = mkdtempSync(join(artifacts, "two-connections-"));
  const connections: ProjectDatabase[] = [];
  try {
    const db = ProjectDatabase.create(join(directory, "project.sqlite"), {
      id: crypto.randomUUID(),
      name: "Конкурентные задачи",
      slug: "task-transactions",
    });
    connections.push(db);
    const peer = ProjectDatabase.open(db.path);
    connections.push(peer);
    await run(db, peer);
  } finally {
    for (const connection of connections.toReversed()) {
      connection.close();
    }
    rmSync(directory, { recursive: true, force: true });
  }
}
