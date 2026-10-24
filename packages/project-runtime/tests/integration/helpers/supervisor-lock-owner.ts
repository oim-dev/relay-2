import { mkdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireLocalLock } from "@relay/storage";
import { readGitSyncControlEndpoint, type GitSyncControlEndpoint } from "@relay/project-runtime";

// Отдельный процесс удерживает настоящий SQLite mutex до EOF тестового lease.
// Fixture воспроизводит только lifetime SQLite и loopback health supervisor.
const homeArgument = process.argv[2];
const instance = process.argv[3];
if (!homeArgument || !instance) {
  throw new Error("Нужны home и instance владельца mutex");
}
mkdirSync(join(homeArgument, "git-sync"), { recursive: true });
const home = realpathSync(homeArgument);
const path = join(home, "git-sync/supervisor.json");
const lock = acquireLocalLock(`${path}.ownership.sqlite`);
const capability = crypto.randomUUID();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  /**
   * Подтверждает только health данного владельца; readiness не освобождает его mutex.
   */
  async fetch(request): Promise<Response> {
    const body: unknown = await request.json();
    if (
      request.headers.get("authorization") !== `Bearer ${capability}` ||
      !body ||
      typeof body !== "object" ||
      !("instance" in body) ||
      body.instance !== instance ||
      !("action" in body) ||
      body.action !== "health"
    ) {
      return new Response(null, { status: 403 });
    }
    return Response.json({
      version: 1,
      ok: true,
      data: {
        version: 1,
        release: "0.0.0/git-sync-v1",
        kind: "supervisor",
        identity: home,
        instance,
        heartbeat: new Date().toISOString(),
      },
    });
  },
});
try {
  const endpoint: GitSyncControlEndpoint = {
    version: 1,
    release: "0.0.0/git-sync-v1",
    kind: "supervisor",
    identity: home,
    instance,
    pid: process.pid,
    port: server.port ?? 0,
    capability,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(path, JSON.stringify(endpoint));
  process.stdout.write("ready\n");
  await Bun.stdin.text();
} finally {
  try {
    if (readGitSyncControlEndpoint(path)?.instance === instance) {
      unlinkSync(path);
    }
    await server.stop(true);
  } finally {
    lock.release();
  }
}
