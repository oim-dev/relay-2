import { expect } from "bun:test";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { NativeCommands } from "./native-command";
import type { NativeConfiguration, NativeSession } from "./native-service.types";
import {
  assertWindowsAbsent,
  assertWindowsRegistration,
  crashWindowsSupervisor,
  removeWindowsRegistration,
} from "./native-windows";

/**
 * Наблюдает настоящий manager и внедряет аварийный exit только собственной регистрации.
 * Готовность приложения проверяется отдельно публичным health-протоколом Runtime.
 */
export class NativeManager {
  /* Адрес LaunchAgent в gui-домене текущей сессии; на других ОС не используется. */
  private readonly launchTarget: string;

  /**
   * Запоминает уникальную конфигурацию fixture без регистрации и файловых записей.
   */
  constructor(
    /* Реальные системные команды и их журнал. */
    private readonly commands: NativeCommands,
    /* Уникальные ID и config-path собственной службы. */
    private readonly config: NativeConfiguration,
    /* Ожидаемый абсолютный executable, скопированный в fixture. */
    private readonly binary: string,
    session: NativeSession,
  ) {
    this.launchTarget = `gui/${session.uid}/${config.id}`;
  }

  /**
   * Проверяет привязку живого PID и точных argv к своему user-manager.
   */
  async assertRegistered(pid: number): Promise<void> {
    const { config, commands, binary } = this;
    if (config.platform === "win32") {
      await assertWindowsRegistration(commands, config, binary, pid);
      return;
    }
    if (config.platform === "darwin") {
      const registration = await commands.run("launchctl", ["print", this.launchTarget]);
      expect(registration.stdout).toMatch(new RegExp(`\\bpid = ${pid}\\b`));
      const plist = await commands.run("plutil", ["-convert", "json", "-o", "-", config.path]);
      expect(JSON.parse(plist.stdout)).toMatchObject({
        Label: config.id,
        ProgramArguments: [binary, "supervise", "--home", config.home],
        RunAtLoad: true,
        KeepAlive: { SuccessfulExit: false },
      });
      return;
    }
    const fields = await this.linuxProperties();
    expect(fields).toMatchObject({
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
   * Доказывает удаление native-регистрации независимо от статуса Runtime и отсутствия health.
   */
  async assertAbsent(): Promise<void> {
    const { config, commands } = this;
    if (config.platform === "win32") {
      await assertWindowsAbsent(commands, config);
    } else if (config.platform === "darwin") {
      const result = await commands.run("launchctl", ["print", this.launchTarget], [0, 113]);
      expect(result.exitCode).toBe(113);
    } else {
      const fields = await this.linuxProperties();
      expect(fields.LoadState).toBe("not-found");
      expect(fields.ActiveState).toBe("inactive");
      expect(fields.MainPID).toBe("0");
      expect(existsSync(join(dirname(config.path), "default.target.wants", config.id))).toBe(false);
    }
  }

  /**
   * Вызывает отказ реального supervisor без restart/start: его восстановить должен сам manager.
   */
  async crash(pid: number): Promise<void> {
    await this.assertRegistered(pid);
    if (this.config.platform === "linux") {
      await this.commands.run("systemctl", [
        "--user",
        "kill",
        "--kill-whom=main",
        "--signal=SIGKILL",
        this.config.id,
      ]);
    } else if (this.config.platform === "darwin") {
      await this.commands.run("launchctl", ["kill", "SIGKILL", this.launchTarget]);
    } else {
      await crashWindowsSupervisor(this.commands, this.binary, pid);
    }
  }

  /**
   * Снимает свою регистрацию после неудавшегося production cleanup. Вызывающий обязан
   * до первого enable подтвердить отсутствие ID, а после fallback сохранить отказ теста.
   */
  async emergencyRemove(): Promise<void> {
    const { config, commands } = this;
    if (existsSync(config.path)) {
      const content = readFileSync(config.path, config.platform === "win32" ? "utf16le" : "utf8");
      if (!content.includes(config.marker)) {
        throw new Error(`Аварийная уборка отвергла чужую конфигурацию ${config.path}`);
      }
    }
    if (config.platform === "linux") {
      await commands.run("systemctl", ["--user", "disable", "--now", config.id], [0, 1, 5]);
    } else if (config.platform === "darwin") {
      await commands.run("launchctl", ["bootout", this.launchTarget], [0, 113]);
    } else {
      await removeWindowsRegistration(commands, config);
    }
    rmSync(config.path, { force: true });
    if (config.platform === "linux") {
      await commands.run("systemctl", ["--user", "daemon-reload"]);
    }
  }

  /**
   * Читает машинные свойства одного unit; иные ошибки DBus не считаются отсутствием.
   */
  private async linuxProperties(): Promise<Readonly<Record<string, string>>> {
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
