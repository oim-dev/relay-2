import { describe, expect, test } from "bun:test";
import { createGitSyncFixture } from "./helpers/git-sync-fixture";
import { readGitSyncStatus, readSingleGitSyncStatus } from "./helpers/git-sync-status";
import { invokeSuccess } from "../../apps/cli/tests/e2e/helpers/workflow-fixture";

describe("Управление постоянным Git worker через CLI", () => {
  test("auto enable подтверждает готовность, следующий процесс видит тот же worker, а stop сохраняет остановку", async () => {
    const fixture = await createGitSyncFixture();
    const { a, remote } = fixture;
    try {
      await invokeSuccess(a, a.cwd, ["init", "--name", "Фоновый обмен", "--slug", "automatic"]);
      fixture.ownWorker(a);
      await invokeSuccess(a, a.cwd, [
        "git-sync",
        "connect",
        "--remote",
        remote,
        "--branch",
        "relay-data-v2",
      ]);
      await fixture.startSupervisor(a);

      // Команда завершается после readiness протокола, поэтому произвольная задержка не нужна.
      const enabled = readGitSyncStatus(
        await invokeSuccess(a, a.cwd, ["git-sync", "auto", "enable"]),
      );

      expect(enabled).toMatchObject({
        mode: "auto",
        worker: { desired: "running", actual: "running", responsive: true },
      });
      const instance = enabled.worker.instance;
      expect(instance).not.toBeNull();
      const started = readGitSyncStatus(
        await invokeSuccess(a, a.cwd, ["git-sync", "worker", "start"]),
      );
      expect(started).toMatchObject({
        mode: "auto",
        worker: { desired: "running", actual: "running", responsive: true, instance },
      });
      const observed = readSingleGitSyncStatus(
        await invokeSuccess(a, a.cwd, ["git-sync", "status"]),
      );
      expect(observed).toMatchObject({
        mode: "auto",
        worker: { desired: "running", actual: "running", responsive: true, instance },
      });

      const stopResult = readGitSyncStatus(
        await invokeSuccess(a, a.cwd, ["git-sync", "worker", "stop"]),
      );

      expect(stopResult).toMatchObject({
        worker: { desired: "stopped", actual: "stopped", responsive: false },
        nextRetry: null,
      });
      const stopped = readSingleGitSyncStatus(
        await invokeSuccess(a, a.cwd, ["git-sync", "status"]),
      );
      expect(stopped).toMatchObject({
        worker: { desired: "stopped", actual: "stopped", responsive: false },
        nextRetry: null,
      });
    } finally {
      await fixture.close();
    }
  }, 60_000);
});
