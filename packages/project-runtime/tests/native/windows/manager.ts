import { rmSync } from "node:fs";
import type { NativeCommands } from "../native-command";
import type { NativeConfiguration, NativeManager } from "../native-service.types";
import { assertOwnedConfiguration } from "../native-manager-ownership";
import {
  assertWindowsAbsent,
  assertWindowsRegistration,
  crashWindowsSupervisor,
  removeWindowsRegistration,
} from "./registration";

/**
 * Наблюдает одну task и её процесс через COM/Win32 независимо от production status.
 */
export class WindowsNativeManager implements NativeManager {
  /**
   * Запоминает собственные ID и executable fixture без регистрации task.
   */
  constructor(
    /* Ограниченный запуск настоящих системных команд с журналом. */
    private readonly commands: NativeCommands,
    /* Единственная task fixture, отсутствие которой подтверждено до enable. */
    private readonly config: NativeConfiguration,
    /* Ожидаемый executable для проверки SID и удерживаемого process handle. */
    private readonly binary: string,
  ) {}

  /**
   * Проверяет COM-настройки, principal, repetition и точные argv живого supervisor.
   */
  async assertRegistered(pid: number): Promise<void> {
    await assertWindowsRegistration(this.commands, this.config, this.binary, pid);
  }

  /**
   * Проверяет отсутствие task по HRESULT, не принимая другие ошибки COM за отсутствие.
   */
  async assertAbsent(): Promise<void> {
    await assertWindowsAbsent(this.commands, this.config);
  }

  /**
   * Внедряет ненулевой exit, не вызывая Task Scheduler Stop/End/Run.
   */
  async crash(pid: number): Promise<void> {
    await this.assertRegistered(pid);
    await this.killSupervisor(pid);
  }

  /**
   * Снимает только свою task по маркеру после отказа проверяемого disable.
   */
  async emergencyRemove(): Promise<void> {
    assertOwnedConfiguration(this.config, "utf16le");
    await removeWindowsRegistration(this.commands, this.config);
    rmSync(this.config.path, { force: true });
  }

  /**
   * После живого health дополнительно сверяет SID/executable и завершает удержанный Win32 handle.
   */
  async killSupervisor(pid: number): Promise<void> {
    await crashWindowsSupervisor(this.commands, this.binary, pid);
  }
}
