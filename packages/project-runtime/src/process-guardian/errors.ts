import { guardianMessages } from "./guardian.messages";
import type {
  GuardedCommandFailureDetails,
  GuardedCommandFailureReason,
  GuardedCommandFailureStage,
  GuardedCommandSystemCode,
} from "./guardian.types";

/**
 * Сохраняет локальную cause либо восстанавливает только безопасные поля удалённого native отказа.
 */
function restoredCause(details: GuardedCommandFailureDetails): unknown {
  if (details.cause !== undefined) {
    return details.cause;
  }
  if (details.stage === undefined) {
    return undefined;
  }
  return {
    stage: details.stage,
    ...(details.systemCode === undefined ? {} : { systemCode: details.systemCode }),
  };
}

/**
 * Отказ guardian, отличающийся от ненулевого exit code команды.
 * reason предназначен для программного отображения; диагностики команды не редактируются.
 * Удалённый native отказ восстанавливается в cause как GuardedCommandDiagnostic без native message.
 */
export class GuardedCommandError extends Error {
  /* Стабильная причина инфраструктурного отказа. */
  readonly reason: GuardedCommandFailureReason;
  /* Ограниченный частичный stdout без перекодирования. */
  readonly stdout: Uint8Array;
  /* Ограниченный частичный stderr; может содержать секреты внешней команды. */
  readonly stderr: string;
  /* Этап запуска; отсутствует у ошибок без native-диагностики. */
  readonly stage?: GuardedCommandFailureStage;
  /* Системный код errno/Win32, когда он известен; не содержит произвольного сообщения. */
  readonly systemCode?: GuardedCommandSystemCode;

  /**
   * Сохраняет исходную причину и уже полученные потоки без включения их в message.
   */
  constructor(reason: GuardedCommandFailureReason, details: GuardedCommandFailureDetails = {}) {
    super(guardianMessages[reason], { cause: restoredCause(details) });
    this.name = "GuardedCommandError";
    this.reason = reason;
    this.stdout = details.stdout ?? new Uint8Array();
    this.stderr = details.stderr ?? "";
    if (details.stage !== undefined) {
      this.stage = details.stage;
    }
    if (details.systemCode !== undefined) {
      this.systemCode = details.systemCode;
    }
  }
}
