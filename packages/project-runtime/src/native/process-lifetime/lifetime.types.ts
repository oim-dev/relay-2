import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { CommandTree } from "../../process-guardian/tree.types";

/**
 * Реальная граница удержания потомков, используемая также в диагностике Git Sync.
 */
export type ProcessTreeCapability =
  "linux-subreaper" | "windows-job" | "posix-group-foreground-only";

/**
 * Контекст graceful-остановки непосредственной команды живым якорем.
 */
export interface AnchorStop {
  /* Только принадлежащий якорю child; undefined до успешного spawn. */
  readonly child: ChildProcess | undefined;
  /* Exit уже получен; повторное завершение непосредственного процесса не требуется. */
  readonly commandEnded: boolean;
  /* Команда понимает закрытие stdin как graceful shutdown. */
  readonly stdinLease: boolean;
  /* Явная отмена; EOF владельца обрабатывается общим lease-протоколом. */
  readonly signal: "SIGINT" | "SIGTERM";
}

/**
 * Нативное владение процессами: создание контейнера, graceful-остановка и потеря владельца.
 * Адаптер не управляет протоколом, бюджетом вывода и deadline сценария. Его контейнер
 * подтверждает cleanup в пределах capability, затем освобождает собственные native handles.
 */
export interface ProcessLifetime {
  /* Проверяемая гарантия удержания; macOS не удерживает произвольный setsid. */
  readonly capability: ProcessTreeCapability;
  /* Native flags отдельного guardian/anchor; env, cwd и stdio задаёт вызывающий. */
  readonly guardianSpawn: Readonly<Pick<SpawnOptions, "detached" | "windowsHide">>;
  /* Native flags команды внутри уже назначенного контейнера. */
  readonly commandSpawn: Readonly<Pick<SpawnOptions, "windowsHide">>;
  /**
   * Привязывает созданный якорь к контейнеру до разрешения запуска команды.
   */
  ownTree(pid: number): CommandTree;
  /**
   * Выполняет native-действие якоря после потери guardian.
   */
  ownerLost(): void;
  /**
   * Доставляет graceful-остановку; force cleanup принадлежит контейнеру guardian.
   */
  stopAnchor(input: AnchorStop): void;
}
