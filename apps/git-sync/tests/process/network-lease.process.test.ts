import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ownControl, controlRequest } from "../../src/local/control";
import type { ControlOwner } from "../../src/local/control.types";
import { withNetworkPermit } from "../../src/worker/network-permit";
import { requestObject } from "../../src/app/protocol";
import { withProcessFixture, eventually } from "./process-fixture";
import { startTestSupervisor } from "./supervisor-fixture";
import { runProcess } from "../../src/transport/process";

/**
 * Держит только собственный lease до отмены, не создавая предметной работы.
 */
function untilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

describe("Сетевой budget принадлежит живому stream", () => {
  test("EOF supervisor отменяет выполняющийся child и не продолжает attempt без budget", async () => {
    await withProcessFixture(async (fixture) => {
      const context = fixture.context("lost-supervisor", false);
      const home = context.options.home;
      if (!home) {
        throw new Error("isolated home required");
      }
      const supervisor = await startTestSupervisor(fixture.binary, context.options);
      const database = join(fixture.root, "lease-child.sqlite");
      const owner = await ownControl(
        `${database}.git-sync/worker.json`,
        "request",
        database,
        async () => null,
      );
      const entered = join(fixture.root, "lease-child-entered");
      const cancellation = new AbortController();
      const operation = withNetworkPermit(
        home,
        owner.endpoint,
        cancellation.signal,
        async (signal) => {
          await runProcess({
            executable: process.execPath,
            args: [
              "-e",
              `require('node:fs').writeFileSync(${JSON.stringify(entered)},'entered');setInterval(()=>{},1000)`,
            ],
            cwd: fixture.root,
            signal,
            timeoutMs: 30_000,
          });
        },
      );
      void operation.catch(() => {});
      try {
        await eventually(() => existsSync(entered));
        await supervisor.stop();

        await expect(operation).rejects.toMatchObject({ code: "GIT_SYNC_LEASE_LOST" });
      } finally {
        cancellation.abort();
        await Promise.allSettled([operation]);
        await owner.close();
        await supervisor.stop();
      }
    });
  }, 20_000);

  for (const queued of [true, false]) {
    test(`SIGKILL ${queued ? "ожидающего" : "получившего slot"} request освобождает budget при оставшемся endpoint-файле`, async () => {
      await withProcessFixture(async (fixture) => {
        const context = fixture.context("lease-control", false);
        const home = context.options.home;
        if (!home) {
          throw new Error("isolated home required");
        }
        const supervisor = await startTestSupervisor(fixture.binary, context.options);
        const owners: ControlOwner[] = [];
        const cancellations: AbortController[] = [];
        const attempts: Promise<void>[] = [];
        let child: ReturnType<typeof Bun.spawn> | undefined;
        try {
          if (queued) {
            for (let index = 0; index < 4; index++) {
              const database = join(fixture.root, `holder-${index}.sqlite`);
              const owner = await ownControl(
                `${database}.git-sync/worker.json`,
                "request",
                database,
                async () => null,
              );
              owners.push(owner);
              const cancellation = new AbortController();
              cancellations.push(cancellation);
              const ready = Promise.withResolvers<void>();
              const attempt = withNetworkPermit(
                home,
                owner.endpoint,
                cancellation.signal,
                (signal) => {
                  ready.resolve();
                  return untilAborted(signal);
                },
              );
              void attempt.catch(() => {});
              attempts.push(attempt);
              await ready.promise;
            }
          }
          const database = join(fixture.root, "dead-request.sqlite");
          const endpointPath = `${database}.git-sync/worker.json`;
          const script = join(fixture.root, "lease-client.ts");
          const controlModule = fileURLToPath(
            new URL("../../src/local/control.ts", import.meta.url),
          );
          const permitModule = fileURLToPath(
            new URL("../../src/worker/network-permit.ts", import.meta.url),
          );
          writeFileSync(
            script,
            `import {ownControl} from ${JSON.stringify(controlModule)}; import {withNetworkPermit} from ${JSON.stringify(permitModule)}; const owner=await ownControl(${JSON.stringify(endpointPath)},'request',${JSON.stringify(database)},async()=>null); const stop=new AbortController(); await withNetworkPermit(${JSON.stringify(home)},owner.endpoint,stop.signal,()=>new Promise(()=>{}));\n`,
          );
          child = Bun.spawn([process.execPath, script], {
            cwd: fixture.root,
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          });
          await eventually(async () => {
            const result = await controlRequest(supervisor.endpoint, "status");
            if (!result?.ok) {
              return false;
            }
            const status = requestObject(result.data);
            return queued ? status.waitingNetwork === 1 : status.activeNetwork === 1;
          });

          child.kill("SIGKILL");
          await child.exited;
          await eventually(async () => {
            const result = await controlRequest(supervisor.endpoint, "status");
            if (!result?.ok) {
              return false;
            }
            const status = requestObject(result.data);
            return queued ? status.waitingNetwork === 0 : status.activeNetwork === 0;
          });
          expect(existsSync(endpointPath)).toBe(true);
          for (const cancellation of cancellations) {
            cancellation.abort();
          }
          await Promise.allSettled(attempts);
          const healthyDb = join(fixture.root, "healthy.sqlite");
          const healthy = await ownControl(
            `${healthyDb}.git-sync/worker.json`,
            "request",
            healthyDb,
            async () => null,
          );
          owners.push(healthy);
          let granted = false;
          await withNetworkPermit(
            home,
            healthy.endpoint,
            new AbortController().signal,
            async () => {
              granted = true;
            },
          );
          expect(granted).toBe(true);
        } finally {
          if (child && child.exitCode === null) {
            child.kill("SIGKILL");
            await child.exited;
          }
          for (const cancellation of cancellations) {
            cancellation.abort();
          }
          await Promise.allSettled(attempts);
          await Promise.allSettled(owners.map((owner) => owner.close()));
          await supervisor.stop();
        }
      });
    }, 30_000);
  }
});
