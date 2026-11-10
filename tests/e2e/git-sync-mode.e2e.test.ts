import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveProject } from "@relay/project-runtime";
import { createGitSyncFixture } from "./helpers/git-sync-fixture";
import { readSingleGitSyncStatus } from "./helpers/git-sync-status";
import { invokeRecord, invokeSuccess } from "../../apps/cli/tests/e2e/helpers/workflow-fixture";

describe("Одноразовая синхронизация через CLI", () => {
  test("manual сохраняет локальные данные до now, auto включается без постоянного процесса", async () => {
    const fixture = await createGitSyncFixture();
    const { a, b, remote } = fixture;
    try {
      await invokeSuccess(a, a.cwd, ["init", "--name", "Обмен при обращении"]);
      await invokeSuccess(a, a.cwd, ["git-sync", "auto", "disable"]);
      const document = await invokeRecord(a, a.cwd, [
        "document",
        "create",
        "--name",
        "До обмена",
        "--body",
        "Точный локальный текст",
        "--actor",
        "author",
      ]);
      await invokeSuccess(a, a.cwd, ["git-sync", "connect", "--remote", remote]);
      const pending = readSingleGitSyncStatus(
        await invokeSuccess(a, a.cwd, ["git-sync", "status"]),
      );
      expect(pending.mode).toBe("manual");
      expect(pending.pending.changesets).toBeGreaterThan(0);

      await invokeSuccess(a, a.cwd, ["git-sync", "now"]);
      await invokeSuccess(b, b.cwd, ["git-sync", "restore", "--remote", remote]);
      const received = await invokeRecord(b, b.cwd, ["document", "get", document.id]);

      expect(received.data.body).toBe("Точный локальный текст");
      expect(
        readSingleGitSyncStatus(await invokeSuccess(a, a.cwd, ["git-sync", "status"])).pending
          .changesets,
      ).toBe(0);
      await invokeSuccess(a, a.cwd, ["git-sync", "auto", "enable"]);
      expect(
        readSingleGitSyncStatus(await invokeSuccess(a, a.cwd, ["git-sync", "status"])),
      ).toMatchObject({ mode: "auto", worker: { responsive: false } });
      const home = a.variables.RELAY_HOME;
      if (home === undefined) {
        throw new Error("Fixture должна задавать изолированный RELAY_HOME");
      }
      const location = resolveProject({ cwd: a.cwd, home });
      expect(existsSync(join(home, "projects", location.projectId, "state", "worker.json"))).toBe(
        false,
      );
    } finally {
      await fixture.close();
    }
  }, 60_000);
});
