import { constants } from "node:os";
import { guardianFailureStages, maxSystemCodeLength } from "./diagnostics.constants";
import type {
  GuardedCommandDiagnostic,
  GuardedCommandFailureStage,
  GuardedCommandSystemCode,
} from "./guardian.types";

/**
 * Принимает только известный этап, не произвольный текст из native error.
 */
export function failureStage(value: unknown): value is GuardedCommandFailureStage {
  return guardianFailureStages.some((stage) => stage === value);
}

/**
 * Принимает символ errno текущей ОС либо uint32 Win32-код; пути и сообщения запрещены.
 */
export function systemCode(value: unknown): value is GuardedCommandSystemCode {
  return typeof value === "number"
    ? Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff
    : typeof value === "string" &&
        value.length <= maxSystemCodeLength &&
        Object.hasOwn(constants.errno, value);
}

/**
 * Извлекает только безопасный системный код из ограниченной цепочки cause.
 * Native message, argv, path и env никогда не копируются в межпроцессную диагностику.
 */
export function spawnDiagnostic(
  stage: GuardedCommandFailureStage,
  cause: unknown,
): GuardedCommandDiagnostic {
  let current = cause;
  for (let depth = 0; depth < 3; depth++) {
    if (typeof current === "number" && systemCode(current)) {
      return { stage, systemCode: current };
    }
    if (current === null || typeof current !== "object") {
      break;
    }
    if ("systemCode" in current && systemCode(current.systemCode)) {
      return { stage, systemCode: current.systemCode };
    }
    if ("code" in current && systemCode(current.code)) {
      return { stage, systemCode: current.code };
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return { stage };
}
