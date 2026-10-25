import { describe, expect, spyOn, test } from "bun:test";
import { EventsService } from "../../src/modules/events/events.service";
import { withServer } from "./fixture";

describe("Владение bounded SSE subscriptions", () => {
  test("отписка одного consumer сохраняет общий watcher; close завершает второго и освобождает timer", async () => {
    await withServer(
      async ({ server, location }) => {
        const events = server.app.get(EventsService);
        const scheduled = spyOn(globalThis, "setInterval");
        const cleared = spyOn(globalThis, "clearInterval");
        try {
          const first = await events.response(location.projectId, new AbortController().signal);
          const second = await events.response(location.projectId, new AbortController().signal);
          const one = first.body?.getReader();
          const two = second.body?.getReader();
          if (one === undefined || two === undefined) {
            throw new Error("SSE должен предоставлять два независимых reader");
          }
          try {
            expect(scheduled).toHaveBeenCalledTimes(1);
            const timer = scheduled.mock.results[0]?.value;
            expect(timer).toBeDefined();

            await one.cancel();
            expect(cleared).not.toHaveBeenCalledWith(timer);
            expect(new TextDecoder().decode((await two.read()).value)).toContain(
              "event: connected",
            );
            const waiting = two.read();
            await events.close();

            expect((await waiting).done).toBe(true);
            expect(cleared).toHaveBeenCalledWith(timer);
            await expect(
              events.response(location.projectId, new AbortController().signal),
            ).rejects.toMatchObject({ code: "SERVER_CLOSING" });
          } finally {
            await one.cancel();
            await two.cancel();
          }
        } finally {
          await events.close();
          scheduled.mockRestore();
          cleared.mockRestore();
        }
      },
      { eventIntervalMs: 60_000, heartbeatIntervalMs: 60_000 },
    );
  });
});
