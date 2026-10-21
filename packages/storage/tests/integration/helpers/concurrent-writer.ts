import { Worker } from "node:worker_threads";
import type {
  ConcurrentWriterHandle,
  ConcurrentWriterMessage,
  ConcurrentWriterResult,
} from "./concurrent-writer.types";

/**
 * Проверяет сообщения отдельного потока, чтобы нарушение протокола не выглядело готовностью.
 */
function decodeWriterMessage(value: unknown): ConcurrentWriterMessage {
  if (value === null || typeof value !== "object" || !("type" in value)) {
    throw new Error("Некорректное сообщение конкурентного писателя");
  }
  if (value.type === "ready") {
    return { type: "ready" };
  }
  if (
    value.type === "result" &&
    "keys" in value &&
    Array.isArray(value.keys) &&
    value.keys.every((key: unknown) => typeof key === "string") &&
    "outcome" in value &&
    (value.outcome === "updated" || value.outcome === "REVISION_CONFLICT")
  ) {
    return { type: "result", keys: value.keys, outcome: value.outcome };
  }
  throw new Error("Неизвестный результат конкурентного писателя");
}

/**
 * Запускает писателя и регистрирует барьер готовности и результат с обработкой ошибок потока.
 * Дедлайн и terminate принадлежат тесту, чтобы очистка охватывала обоих участников.
 */
export function startConcurrentWriter(path: string, actor: string): ConcurrentWriterHandle {
  const worker = new Worker(new URL("../concurrent-writer.ts", import.meta.url), {
    workerData: { path, actor },
  });
  const ready = new Promise<void>((resolveReady, reject) => {
    worker.on("message", (value: unknown) => {
      try {
        if (decodeWriterMessage(value).type === "ready") {
          resolveReady();
        }
      } catch (error) {
        reject(error);
      }
    });
    worker.on("error", reject);
    worker.on("exit", (code) => reject(new Error(`Писатель завершился до барьера: ${code}`)));
  });
  const result = new Promise<ConcurrentWriterResult>((resolveResult, reject) => {
    worker.on("message", (value: unknown) => {
      try {
        const message = decodeWriterMessage(value);
        if (message.type === "result") {
          resolveResult(message);
        }
      } catch (error) {
        reject(error);
      }
    });
    worker.on("error", reject);
    worker.on("exit", (code) => reject(new Error(`Писатель завершился без результата: ${code}`)));
  });
  return { worker, ready, result };
}
