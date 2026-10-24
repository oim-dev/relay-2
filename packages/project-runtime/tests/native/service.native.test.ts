import { describe, expect, test } from "bun:test";
import { waitForGitSyncSupervisor } from "@relay/project-runtime";
import { requireNativeServiceOptIn } from "./native-environment";
import { withNativeServiceFixture } from "./native-fixture";

// Ошибка на входе обязательна и при прямом bun test: включённая приёмка не может тихо стать skip.
requireNativeServiceOptIn();

describe("Настоящий пользовательский manager Git Sync", () => {
  test("enable, повторный enable и crash дают новые ready-instance; disable удаляет службу и сохраняет проект", async () => {
    await withNativeServiceFixture(async (fixture) => {
      const before = await fixture.service("status", "before-enable");
      expect(before).toMatchObject({
        installed: false,
        registered: false,
        desiredRegistration: "disabled",
      });
      expect(before.supervisor).toMatchObject({ actual: "stopped", responsive: false });

      const enabled = await fixture.service("enable", "enabled");
      expect(enabled).toMatchObject({
        id: fixture.config.id,
        installed: true,
        registered: true,
        desiredRegistration: "enabled",
      });
      expect(enabled.enabled).not.toBe(false);
      const first = await fixture.verifyRunning(enabled.supervisor);

      const repeated = await fixture.service("enable", "repeated-enable");
      expect(repeated.id).toBe(enabled.id);
      expect(repeated.configPath).toBe(enabled.configPath);
      const restarted = await fixture.verifyRunning(repeated.supervisor);
      expect(restarted.instance).not.toBe(first.instance);
      await fixture.assertExited([first.pid]);

      await fixture.manager.crash(restarted.pid);
      // Здесь не вызывается ни service enable, ни native start/restart: восстанавливает только manager.
      const recovered = await waitForGitSyncSupervisor(fixture.options.home, {
        version: fixture.version,
        previousInstance: restarted.instance,
        // Windows RestartOnFailure имеет настоящий интервал PT1M, заданный production XML.
        timeoutMs: 120_000,
      });
      fixture.save("crash-recovered", recovered);
      const current = await fixture.verifyRunning(recovered);
      expect(current.instance).not.toBe(restarted.instance);
      await fixture.assertExited([restarted.pid]);
      const observed = await fixture.service("status", "after-recovery");
      expect(observed.registered).toBe(true);
      expect(observed.supervisor.instance).toBe(current.instance);

      const disabled = await fixture.service("disable", "disabled");
      expect(disabled).toMatchObject({
        installed: false,
        registered: false,
        enabled: false,
        desiredRegistration: "disabled",
      });
      await fixture.assertDisabled();
      fixture.assertProjectPreserved();
      const disabledAgain = await fixture.service("disable", "disabled-again");
      expect(disabledAgain).toMatchObject({
        installed: false,
        registered: false,
        desiredRegistration: "disabled",
      });
      await fixture.assertDisabled();
    });
  }, 300_000);
});
