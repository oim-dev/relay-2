import { expect } from "bun:test";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { NativeCommands } from "../native-command";
import type { NativeConfiguration, NativeManager } from "../native-service.types";
import { assertOwnedConfiguration } from "../native-manager-ownership";

/**
 * Наблюдает собственный user-systemd unit и его настоящий процесс независимо от Runtime.
 */
export class LinuxNativeManager implements NativeManager {
  /**
   * Запоминает уникальную регистрацию fixture без изменения manager.
   */
  constructor(
    /* Ограниченный запуск настоящих системных команд с журналом. */
    private readonly commands: NativeCommands,
    /* Единственный unit fixture, отсутствие которого проверено до enable. */
    private readonly config: NativeConfiguration,
    /* Точный физический executable fixture. */
    private readonly binary: string,
  ) {}

  /**
   * Сверяет systemd, login-ссылку, executable и kernel argv наблюдаемого supervisor.
   */
  async assertRegistered(pid: number): Promise<void> {
    const { config, binary } = this;
    expect(await this.properties()).toMatchObject({
      LoadState: "loaded",
      ActiveState: "active",
      UnitFileState: "enabled",
      MainPID: String(pid),
      FragmentPath: config.path,
      Restart: "on-failure",
      KillMode: "control-group",
    });
    expect(realpathSync(join(dirname(config.path), "default.target.wants", config.id))).toBe(
      config.path,
    );
    expect(realpathSync(`/proc/${pid}/exe`)).toBe(binary);
    expect(readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean)).toEqual([
      binary,
      "supervise",
      "--home",
      config.home,
    ]);
  }

  /**
   * Подтверждает отсутствие unit и login-ссылки, не принимая произвольный DBus-отказ за отсутствие.
   */
  async assertAbsent(): Promise<void> {
    const fields = await this.properties();
    expect(fields.LoadState).toBe("not-found");
    expect(fields.ActiveState).toBe("inactive");
    expect(fields.MainPID).toBe("0");
    expect(
      existsSync(join(dirname(this.config.path), "default.target.wants", this.config.id)),
    ).toBe(false);
  }

  /**
   * Внедряет SIGKILL только main-процесса unit; start/restart не вызываются.
   */
  async crash(pid: number): Promise<void> {
    await this.assertRegistered(pid);
    await this.commands.run("systemctl", [
      "--user",
      "kill",
      "--kill-whom=main",
      "--signal=SIGKILL",
      this.config.id,
    ]);
  }

  /**
   * Снимает только свой unit после отказа production cleanup; исходный отказ сохраняет fixture.
   */
  async emergencyRemove(): Promise<void> {
    assertOwnedConfiguration(this.config, "utf8");
    await this.commands.run("systemctl", ["--user", "disable", "--now", this.config.id], [0, 1, 5]);
    rmSync(this.config.path, { force: true });
    await this.commands.run("systemctl", ["--user", "daemon-reload"]);
  }

  /**
   * Завершает PID своего supervisor, только что подтверждённый живым health вызывающей fixture.
   */
  async killSupervisor(pid: number): Promise<void> {
    process.kill(pid, "SIGKILL");
  }

  /**
   * Читает машинные свойства одного unit; неизвестная ошибка DBus не считается отсутствием.
   */
  private async properties(): Promise<Readonly<Record<string, string>>> {
    const result = await this.commands.run(
      "systemctl",
      [
        "--user",
        "show",
        this.config.id,
        "--property=LoadState,ActiveState,UnitFileState,MainPID,FragmentPath,Restart,KillMode",
        "--no-pager",
      ],
      [0, 4],
    );
    return Object.fromEntries(
      result.stdout
        .trim()
        .split("\n")
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
  }
}
