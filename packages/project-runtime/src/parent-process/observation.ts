import { RelayError } from "@relay/contracts";
import { nativeProcessLifetime } from "../native/process-lifetime/select";
import { combineProcessFailures } from "../process-guardian/component-failures";
import { parentProcessMessages as messages } from "./observation.messages";
import type { ParentProcessObservation, ParentProcessProbe } from "./observation.types";

/* Это шаг наблюдения, не deadline cleanup: принадлежащие команды завершает их guardian. */
const observationIntervalMs = 100;

/**
 * Отделяет отказ нативного наблюдения от штатной потери родителя, сохраняя исходную причину.
 */
function observationFailure(cause: unknown): RelayError {
  const error = new RelayError("PROCESS_PARENT_OBSERVATION_FAILED", messages.failed, 1);
  error.cause = cause;
  return error;
}

/**
 * Наблюдает непосредственного родителя текущего процесса без второго supervisor и сигналов по PID.
 * parentPid можно захватить при входе до await/ленивых импортов; чужой уже переиспользованный PID
 * не принимается за исходного родителя. Потеря проверяется сразу и затем каждые 100 мс event loop.
 * Signal отменяется с "parent-exited" либо RelayError; вызывающий связывает его со своим cleanup
 * и обязан обработать ошибочную reason. dispose снимает таймер и native handle; таймер unref.
 * Ошибка захвата выбрасывается синхронно до запуска работы. PID должен быть положительным uint32.
 */
export function observeParentProcess(parentPid = process.ppid): ParentProcessObservation {
  if (!Number.isSafeInteger(parentPid) || parentPid < 1 || parentPid > 0xffff_ffff) {
    throw new RelayError("INVALID_ARGUMENT", messages.invalidParent, 2);
  }
  let probe: ParentProcessProbe;
  try {
    probe = nativeProcessLifetime().captureParent(parentPid);
  } catch (cause) {
    throw observationFailure(cause);
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;
  /**
   * Снимает наблюдение ровно один раз; ошибку native dispose не превращает в успешную очистку.
   */
  function dispose(): void {
    if (disposed) {
      return;
    }
    disposed = true;
    clearInterval(timer);
    try {
      probe.dispose();
    } catch (cause) {
      throw observationFailure(cause);
    }
  }
  /**
   * Сначала освобождает наблюдение, затем отменяет signal, сохраняя также возможную ошибку cleanup.
   */
  function finish(reason: "parent-exited" | RelayError): void {
    let outcome: unknown = reason;
    try {
      dispose();
    } catch (cleanup) {
      outcome = reason === "parent-exited" ? cleanup : combineProcessFailures(reason, cleanup);
    }
    controller.abort(outcome);
  }
  /**
   * Повторяет лишь нативное наблюдение удержанной идентичности; ошибка отменяет работу явно.
   */
  function inspect(): void {
    try {
      if (!probe.isAlive()) {
        finish("parent-exited");
      }
    } catch (cause) {
      finish(observationFailure(cause));
    }
  }
  inspect();
  if (!disposed) {
    timer = setInterval(inspect, observationIntervalMs);
    timer.unref();
  }
  return { signal: controller.signal, dispose };
}
