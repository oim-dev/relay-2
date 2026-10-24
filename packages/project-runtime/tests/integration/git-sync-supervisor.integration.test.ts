import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  probeGitSyncSupervisor,
  waitForGitSyncSupervisor,
  type GitSyncControlEndpoint,
} from "@relay/project-runtime";
import { RuntimeFixture } from "./helpers/runtime-fixture";

const group = "git-sync-implementation/cli-runtime";

/**
 * Публикует только endpoint fixture; данные находятся в собственном каталоге текущего теста.
 */
function publishEndpoint(home: string, endpoint: GitSyncControlEndpoint): void {
  mkdirSync(join(home, "git-sync"), { recursive: true });
  writeFileSync(join(home, "git-sync/supervisor.json"), JSON.stringify(endpoint));
}

describe("Подтверждение готовности supervisor", () => {
  test("старый отзывчивый instance не подтверждает новый native start", async () => {
    const fixture = new RuntimeFixture("git-sync-implementation/review-runtime");
    mkdirSync(fixture.home);
    const home = realpathSync(fixture.home);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      /**
       * Независимый foreground supervisor продолжает отвечать, пока native запуск не готов.
       */
      fetch(): Response {
        return Response.json({
          version: 1,
          ok: true,
          data: {
            version: 1,
            release: "0.0.0/git-sync-v1",
            kind: "supervisor",
            identity: home,
            instance: "foreground-instance",
            heartbeat: "2026-10-24T00:00:00Z",
          },
        });
      },
    });
    try {
      publishEndpoint(home, {
        version: 1,
        release: "0.0.0/git-sync-v1",
        kind: "supervisor",
        identity: home,
        instance: "foreground-instance",
        pid: process.pid,
        port: server.port ?? 0,
        capability: "secret",
        startedAt: "2026-10-24T00:00:00Z",
      });

      await expect(
        waitForGitSyncSupervisor(home, {
          version: "0.0.0",
          timeoutMs: 10,
          previousInstance: "foreground-instance",
        }),
      ).rejects.toMatchObject({
        code: "GIT_SYNC_NOT_READY",
        details: { supervisor: { responsive: true, instance: "foreground-instance" } },
      });
    } finally {
      await server.stop(true);
      await fixture.dispose();
    }
  });

  test("ожидание готовности повторяет только health до ответа того же instance", async () => {
    const fixture = new RuntimeFixture(group);
    mkdirSync(fixture.home);
    const home = realpathSync(fixture.home);
    let probes = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      /**
       * Первый запрос видит опубликованный канал до готовности; второй подтверждает тот же owner.
       */
      fetch(): Response {
        probes++;
        if (probes === 1) {
          return Response.json({
            version: 1,
            ok: false,
            error: { code: "STARTING", message: "starting", exitCode: 4 },
          });
        }
        return Response.json({
          version: 1,
          ok: true,
          data: {
            version: 1,
            release: "0.0.0/git-sync-v1",
            kind: "supervisor",
            identity: home,
            instance: "starting-instance",
            heartbeat: "2026-10-24T00:00:00Z",
          },
        });
      },
    });
    try {
      publishEndpoint(home, {
        version: 1,
        release: "0.0.0/git-sync-v1",
        kind: "supervisor",
        identity: home,
        instance: "starting-instance",
        pid: 1234,
        port: server.port ?? 0,
        capability: "secret",
        startedAt: "2026-10-24T00:00:00Z",
      });

      const status = await waitForGitSyncSupervisor(home, { version: "0.0.0", timeoutMs: 5000 });

      expect(status).toMatchObject({
        actual: "running",
        responsive: true,
        instance: "starting-instance",
      });
      expect(probes).toBe(2);
    } finally {
      await server.stop(true);
      await fixture.dispose();
    }
  });

  test("health проверяет capability, instance и физический home без Git и запуска процесса", async () => {
    const fixture = new RuntimeFixture(group);
    mkdirSync(fixture.home);
    const home = realpathSync(fixture.home);
    const requests: unknown[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      /**
       * Реальный loopback fixture подтверждает только свой точный instance и токен.
       */
      async fetch(request): Promise<Response> {
        requests.push({
          url: new URL(request.url).pathname,
          authorization: request.headers.get("authorization"),
          body: await request.json(),
        });
        return Response.json({
          version: 1,
          ok: true,
          data: {
            version: 1,
            release: "0.0.0/git-sync-v1",
            kind: "supervisor",
            identity: home,
            instance: "instance-1",
            heartbeat: "2026-10-24T00:00:00Z",
          },
        });
      },
    });
    try {
      publishEndpoint(home, {
        version: 1,
        release: "0.0.0/git-sync-v1",
        kind: "supervisor",
        identity: home,
        instance: "instance-1",
        pid: 1,
        port: server.port ?? 0,
        capability: "test-secret",
        startedAt: "2026-10-24T00:00:00Z",
      });

      const status = await probeGitSyncSupervisor(home, { version: "0.0.0" });

      expect(status).toEqual({
        actual: "running",
        responsive: true,
        instance: "instance-1",
        release: "0.0.0/git-sync-v1",
        pid: 1,
        heartbeat: "2026-10-24T00:00:00Z",
      });
      expect(requests).toEqual([
        {
          url: "/control",
          authorization: "Bearer test-secret",
          body: { version: 1, instance: "instance-1", action: "health", input: {} },
        },
      ]);
      expect(JSON.stringify(status)).not.toContain("test-secret");
    } finally {
      await server.stop(true);
      await fixture.dispose();
    }
  });

  test("PID живого процесса и старый endpoint не подменяют несовместимый health", async () => {
    const fixture = new RuntimeFixture(group);
    mkdirSync(fixture.home);
    const home = realpathSync(fixture.home);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      /**
       * Адрес занят другим экземпляром того же компонента.
       */
      fetch(): Response {
        return Response.json({
          version: 1,
          ok: true,
          data: {
            version: 1,
            release: "0.0.0/git-sync-v1",
            kind: "supervisor",
            identity: home,
            instance: "different",
            heartbeat: "2026-10-24T00:00:00Z",
          },
        });
      },
    });
    try {
      publishEndpoint(home, {
        version: 1,
        release: "0.0.0/git-sync-v1",
        kind: "supervisor",
        identity: home,
        instance: "expected",
        pid: process.pid,
        port: server.port ?? 0,
        capability: "secret",
        startedAt: "2026-10-24T00:00:00Z",
      });

      expect(await probeGitSyncSupervisor(home, { version: "0.0.0" })).toMatchObject({
        actual: "incompatible",
        responsive: false,
        instance: "expected",
        heartbeat: null,
      });
      await expect(
        waitForGitSyncSupervisor(home, { version: "0.0.0", timeoutMs: 5000 }),
      ).rejects.toMatchObject({
        code: "GIT_SYNC_NOT_READY",
        details: { supervisor: { actual: "incompatible" } },
      });
    } finally {
      await server.stop(true);
      await fixture.dispose();
    }
  });

  test("отсутствующий endpoint отличается от умершего listener и deadline запуска", async () => {
    const fixture = new RuntimeFixture(group);
    mkdirSync(fixture.home);
    const home = realpathSync(fixture.home);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      /**
       * Listener закрывается до probe, оставляя только локальный endpoint.
       */
      fetch(): Response {
        return new Response();
      },
    });
    const port = server.port ?? 0;
    await server.stop(true);
    try {
      expect(await probeGitSyncSupervisor(home, { version: "0.0.0" })).toEqual({
        actual: "stopped",
        responsive: false,
        instance: null,
        release: null,
        pid: null,
        heartbeat: null,
      });
      publishEndpoint(home, {
        version: 1,
        release: "0.0.0/git-sync-v1",
        kind: "supervisor",
        identity: home,
        instance: "dead",
        pid: process.pid,
        port,
        capability: "secret",
        startedAt: "2026-10-24T00:00:00Z",
      });

      expect(await probeGitSyncSupervisor(home, { version: "0.0.0" })).toMatchObject({
        actual: "unresponsive",
        responsive: false,
        heartbeat: null,
      });
      rmSync(join(home, "git-sync/supervisor.json"));
      await expect(
        waitForGitSyncSupervisor(home, { version: "0.0.0", timeoutMs: 10 }),
      ).rejects.toMatchObject({
        code: "GIT_SYNC_NOT_READY",
        details: { supervisor: { actual: "stopped" } },
      });
    } finally {
      await fixture.dispose();
    }
  });
});
