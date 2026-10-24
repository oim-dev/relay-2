import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ownControl, responsive } from "../../src/local/control";
import type { ControlOwner } from "../../src/local/control.types";
import { NetworkLeases } from "../../src/worker/network-leases";
import { withNetworkPermit } from "../../src/worker/network-permit";
import { withProcessFixture, eventually } from "../process/process-fixture";

describe("Lifetime streaming network lease", () => {
  test("granted и queued streams переживают native HTTP idle interval, сохраняя budget", async () => {
    await withProcessFixture(async (fixture) => {
      const context = fixture.context("idle-lease", false);
      const home = context.options.home;
      if (!home) {
        throw new Error("isolated home required");
      }
      const leases = new NetworkLeases();
      const stop = new AbortController();
      const supervisor = await ownControl(
        join(home, "git-sync", "supervisor.json"),
        "supervisor",
        home,
        async (request, signal) => leases.open(request.requestId, signal),
      );
      const owners: ControlOwner[] = [];
      const promises: Promise<void>[] = [];
      const signals: AbortSignal[] = [];
      const release = Promise.withResolvers<void>();
      let waitingRan = false;
      try {
        for (let index = 0; index < 5; index++) {
          const database = join(fixture.root, `idle-${index}.sqlite`);
          const owner = await ownControl(
            `${database}.git-sync/worker.json`,
            "request",
            database,
            async () => null,
          );
          owners.push(owner);
          const ready = Promise.withResolvers<void>();
          const promise = withNetworkPermit(home, owner.endpoint, stop.signal, async (signal) => {
            signals.push(signal);
            if (index === 4) {
              waitingRan = true;
              return;
            }
            ready.resolve();
            await release.promise;
          });
          void promise.catch(() => {});
          promises.push(promise);
          if (index < 4) {
            await ready.promise;
          }
        }
        await eventually(() => leases.queued === 1);
        // Это длительность самой штатной работы, пересекающая реальный native idle=10s.
        await Bun.sleep(12_000);

        expect(leases.size).toBe(4);
        expect(leases.queued).toBe(1);
        expect(signals.every((signal) => !signal.aborted)).toBe(true);
        expect(waitingRan).toBe(false);
        release.resolve();
        await Promise.all(promises);
        expect(waitingRan).toBe(true);
      } finally {
        release.resolve();
        stop.abort();
        await Promise.allSettled(promises);
        leases.close();
        await Promise.allSettled(owners.map((owner) => owner.close()));
        await supervisor.close();
      }
    });
  }, 20_000);

  test("неожиданный orderly EOF отменяет attempt и не превращается в поздний callback success", async () => {
    await withProcessFixture(async (fixture) => {
      const context = fixture.context("orderly-eof", false);
      const home = context.options.home;
      if (!home) {
        throw new Error("isolated home required");
      }
      const leases = new NetworkLeases();
      const supervisor = await ownControl(
        join(home, "git-sync", "supervisor.json"),
        "supervisor",
        home,
        async (request, signal) => leases.open(request.requestId, signal),
      );
      const database = join(fixture.root, "eof.sqlite");
      const owner = await ownControl(
        `${database}.git-sync/worker.json`,
        "request",
        database,
        async () => null,
      );
      const ready = Promise.withResolvers<AbortSignal>();
      const returnNormally = Promise.withResolvers<void>();
      const stop = new AbortController();
      const operation = withNetworkPermit(home, owner.endpoint, stop.signal, async (signal) => {
        ready.resolve(signal);
        await returnNormally.promise;
      });
      void operation.catch(() => {});
      try {
        const signal = await ready.promise;
        leases.close();
        expect(await responsive(supervisor.endpoint)).toBe(true);
        await eventually(() => signal.aborted, 2000);
        returnNormally.resolve();

        await expect(operation).rejects.toMatchObject({ code: "GIT_SYNC_LEASE_LOST" });
      } finally {
        returnNormally.resolve();
        stop.abort();
        await Promise.allSettled([operation]);
        leases.close();
        await owner.close();
        await supervisor.close();
      }
    });
  }, 10_000);
});
