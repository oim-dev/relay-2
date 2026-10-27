import { expect } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { initializeProject, openProject } from "@relay/project-runtime";
import { createRelayClient, RelayApiError } from "@relay/rest-sdk";
import { startRelayServer } from "../../src/server";
import type { RelayServerOptions } from "../../src/server.types";
import type { ServerFixture } from "./fixture.types";

/**
 * Создаёт SQLite и реальный loopback listener; при любом исходе освобождает server и каталог.
 */
export async function withServer(
  action: (fixture: ServerFixture) => Promise<void>,
  options: Partial<Omit<RelayServerOptions, "runtime">> = {},
): Promise<void> {
  const parent = resolve(
    import.meta.dir,
    "../../../../.artifacts",
    new Date().toISOString().slice(0, 10),
    "server-web/nest-server/fixtures",
  );
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "http-"));
  const runtime = { cwd: join(directory, "project"), home: join(directory, "home") };
  let server: ServerFixture["server"] | undefined;
  try {
    const location = initializeProject({ ...runtime, name: "Nest проект", slug: "nest-test" });
    server = await startRelayServer({
      runtime,
      version: "test",
      actor: "Человек",
      port: 0,
      eventIntervalMs: 10,
      heartbeatIntervalMs: 30,
      ...options,
    });
    await action({
      directory,
      runtime,
      location,
      server,
      client: createRelayClient({ baseUrl: server.url }),
      database: async (operation) => {
        const { database } = openProject(runtime);
        try {
          return await operation(database);
        } finally {
          database.close();
        }
      },
    });
  } finally {
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Проверяет конкретную диагностику SDK и status, исключая успех от постороннего отказа.
 */
export async function apiError(
  action: () => Promise<unknown>,
  code: string,
  status: number,
): Promise<RelayApiError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(RelayApiError);
    if (!(error instanceof RelayApiError)) {
      throw error;
    }
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
    return error;
  }
  throw new Error(`Ожидался ${code}`);
}
