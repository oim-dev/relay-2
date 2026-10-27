import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { initializeProject, openProject } from "@relay/project-runtime";
import type { ProjectDatabase } from "@relay/storage";
import { startRelayServer } from "../../src/server";

/**
 * Владеет отдельными Runtime, SQLite и loopback Server для проверки HTTP-проекций.
 */
export async function withGraphViewServer(
  operation: (url: string, projectId: string, db: ProjectDatabase) => Promise<void>,
): Promise<void> {
  const parent = resolve(
    import.meta.dir,
    "../../../../.artifacts",
    new Date().toISOString().slice(0, 10),
    "graph-view-fixtures",
  );
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "graph-http-"));
  const runtime = { cwd: join(directory, "project"), home: join(directory, "home") };
  const location = initializeProject({ ...runtime, name: "HTTP проекции", slug: "http-views" });
  const { database } = openProject(runtime);
  let server: Awaited<ReturnType<typeof startRelayServer>> | undefined;
  try {
    server = await startRelayServer({ runtime, actor: "Автор", version: "test", port: 0 });
    await operation(server.url, location.projectId, database);
  } finally {
    await server?.close();
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}
