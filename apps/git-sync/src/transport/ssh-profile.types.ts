import type { ProcessInput, ProcessResult } from "./process.types";

/**
 * Запуск ограниченной команды; production использует общий lease guardian.
 */
export type ProcessExecutor = (input: ProcessInput) => Promise<ProcessResult>;

/**
 * Нечувствительная наблюдаемость SSH, сохраняемая для cached status.
 */
export interface SshCapability {
  /* custom не меняет пользовательскую команду; unverified не обещает foreground неизвестного клиента. */
  readonly mode: "not-used" | "custom" | "openssh-foreground" | "unverified";
  /* Только имя источника настройки, никогда не его значение с credentials. */
  readonly source:
    | "default"
    | "GIT_SSH_COMMAND"
    | "GIT_SSH"
    | "GIT_SSH_VARIANT"
    | "core.sshCommand"
    | "ssh.variant"
    | null;
  /* Краткая объявленная версия OpenSSH, null у неизвестного/пользовательского транспорта. */
  readonly implementation: string | null;
  /* Только реально проверенные foreground options; пользовательские identity/proxy сюда не копируются. */
  readonly options: readonly string[];
}

/**
 * SSH профиль одной Git попытки; команда приватна и не выводится в status.
 */
export interface SshProfile {
  /* null оставляет Git выбор команд согласно исходному окружению/config. */
  readonly command: string | null;
  /* Публичная характеристика профиля без значений пользовательских команд. */
  readonly capability: SshCapability;
}

/**
 * Результат probe в точном окружении, которое Git передаст default SSH.
 */
export interface SshProbe {
  /* Абсолютный найденный executable; null при отсутствии ssh в Git PATH. */
  readonly executable: string | null;
  /* Краткая версия известного OpenSSH либо null. */
  readonly implementation: string | null;
  /* Options, проверенные через -G без user config и без подключения к хосту. */
  readonly options: readonly string[];
}

/**
 * Явный контекст проверки SSH; тесты не меняют cwd/PATH самого процесса.
 */
export interface SshProbeContext {
  /* Найденный в Git окружении executable, null при его отсутствии. */
  readonly executable: string | null;
  /* Cwd только дочернего probe. */
  readonly cwd: string;
  /* Платформа выбирает безопасный пустой config, а не пользовательский ~/.ssh/config. */
  readonly platform: string;
}
