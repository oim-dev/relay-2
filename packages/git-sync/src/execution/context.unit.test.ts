import { describe, expect, test } from "bun:test";
import { gitExecutionEnvironment, gitExecutionSignal, withGitExecution } from "./context";

describe("Изоляция библиотечных обращений Git Sync", () => {
  test("параллельные вызовы сохраняют собственную среду и отмену после await", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const firstSignal = new AbortController();
    const secondSignal = new AbortController();
    const previous = process.env.RELAY_TEST_SCOPE;
    const first = withGitExecution(
      { env: { RELAY_TEST_SCOPE: "first", GIT_DIR: "/foreign" }, signal: firstSignal.signal },
      async () => {
        entered.resolve();
        await release.promise;
        return {
          env: gitExecutionEnvironment({ GIT_DIR: undefined }),
          aborted: gitExecutionSignal()?.aborted,
        };
      },
    );
    try {
      await entered.promise;

      const second = await withGitExecution(
        { env: { RELAY_TEST_SCOPE: "second" }, signal: secondSignal.signal },
        async () => {
          firstSignal.abort();
          await Promise.resolve();
          return { env: gitExecutionEnvironment(), aborted: gitExecutionSignal()?.aborted };
        },
      );
      release.resolve();

      expect(second).toEqual({ env: { RELAY_TEST_SCOPE: "second" }, aborted: false });
      expect(await first).toEqual({
        env: { RELAY_TEST_SCOPE: "first", GIT_DIR: undefined },
        aborted: true,
      });
      expect(process.env.RELAY_TEST_SCOPE).toBe(previous);
    } finally {
      release.resolve();
      await first;
    }
  });

  test("отмена отдельной Git-команды не отменяет всё обращение", async () => {
    const caller = new AbortController();
    const command = new AbortController();

    await withGitExecution({ env: {}, signal: caller.signal }, async () => {
      const combined = gitExecutionSignal(command.signal);
      command.abort();

      expect(combined?.aborted).toBe(true);
      expect(caller.signal.aborted).toBe(false);
      expect(gitExecutionSignal()?.aborted).toBe(false);
    });
  });
});
