import { expect } from "bun:test";
import { rmSync } from "node:fs";
import type { NativeCommands } from "../native-command";
import type { NativeConfiguration, NativeManager, NativeSession } from "../native-service.types";
import { assertOwnedConfiguration } from "../native-manager-ownership";

/**
 * Наблюдает собственный LaunchAgent в существующей графической сессии без подмен Runtime.
 */
export class MacosNativeManager implements NativeManager {
  /* Адрес единственного LaunchAgent fixture в gui-домене текущей сессии. */
  private readonly target: string;

  /**
   * Запоминает уникальную регистрацию без обращения к launchd.
   */
  constructor(
    /* Ограниченный запуск настоящих системных команд с журналом. */
    private readonly commands: NativeCommands,
    /* Единственный plist fixture, отсутствие которого проверено до enable. */
    private readonly config: NativeConfiguration,
    /* Точный executable fixture с пробелами и Unicode. */
    private readonly binary: string,
    session: NativeSession,
  ) {
    this.target = `gui/${session.uid}/${config.id}`;
  }

  /**
   * Сверяет PID manager и точные argv/login-политику plist через настоящий plutil.
   */
  async assertRegistered(pid: number): Promise<void> {
    const registration = await this.commands.run("launchctl", ["print", this.target]);
    expect(registration.stdout).toMatch(new RegExp(`\\bpid = ${pid}\\b`));
    const plist = await this.commands.run("plutil", [
      "-convert",
      "json",
      "-o",
      "-",
      this.config.path,
    ]);
    expect(JSON.parse(plist.stdout)).toMatchObject({
      Label: this.config.id,
      ProgramArguments: [this.binary, "supervise", "--home", this.config.home],
      RunAtLoad: true,
      KeepAlive: { SuccessfulExit: false },
    });
  }

  /**
   * Требует штатный код отсутствия именно своей регистрации launchd.
   */
  async assertAbsent(): Promise<void> {
    const result = await this.commands.run("launchctl", ["print", this.target], [0, 113]);
    expect(result.exitCode).toBe(113);
  }

  /**
   * Внедряет crash без start/kickstart: восстановление обязан выполнить launchd.
   */
  async crash(pid: number): Promise<void> {
    await this.assertRegistered(pid);
    await this.commands.run("launchctl", ["kill", "SIGKILL", this.target]);
  }

  /**
   * Снимает только собственный LaunchAgent после отказа production cleanup.
   */
  async emergencyRemove(): Promise<void> {
    assertOwnedConfiguration(this.config, "utf8");
    await this.commands.run("launchctl", ["bootout", this.target], [0, 113]);
    rmSync(this.config.path, { force: true });
  }

  /**
   * Завершает PID, только что подтверждённый живым health своего home/instance.
   */
  async killSupervisor(pid: number): Promise<void> {
    process.kill(pid, "SIGKILL");
  }
}
