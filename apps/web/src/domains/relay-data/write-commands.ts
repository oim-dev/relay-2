import type { BatchResult, NamedCommand } from "@relay/contracts";
import { RelayApiError, type RelayClient } from "@relay/rest-sdk";
import type {
  PendingWrite,
  PendingWriteRecovery,
  RecoverableWriteCommands,
} from "./relay-data.types";
import { dataMessages } from "./relay-data.messages";

/**
 * Сохраняет неопределённый исход вместе с исходным запросом для явной повторной проверки.
 */
export class UncertainWriteError extends Error {
  /* Стабильный код, который формы отличают от достоверного отказа записи. */
  readonly code = "UNRESOLVED_OPERATION";
}

/**
 * Возвращает origin страницы; вне браузера изоляцией владеет экземпляр writer.
 */
function browserOrigin(): string {
  return typeof location === "undefined" ? "" : location.origin;
}

/**
 * Создаёт реестр операций вкладки. Команды и ключ фиксируются синхронно до context().
 * Одинаковые конкурентные вызовы разделяют весь запрос; другая запись того же проекта
 * блокируется до достоверного исхода. Это также закрывает обход при смене состава batch.
 * После обрыва только явный повтор читает receipt и при её отсутствии отправляет
 * исходный пакет без обновления guards. Recovery-методы доступны и после unmount формы.
 */
export function createWriteCommands(
  client: RelayClient,
  getOrigin: () => string = browserOrigin,
): RecoverableWriteCommands {
  const pending = new Map<string, PendingWrite>();
  const subscriptions = new Map<string, Set<() => void>>();

  /**
   * Адресует состояние выбранного проекта только в текущем origin.
   */
  function scopeKey(project: string): string {
    return JSON.stringify([getOrigin(), project]);
  }

  /**
   * Уведомляет слушателей после изменения снимка. Callback не входит в Promise записи:
   * ошибка рендера не должна превращать подтверждённый commit в отказ транспорта.
   */
  function notify(key: string): void {
    const listeners = subscriptions.get(key);
    for (const listener of listeners ?? []) {
      queueMicrotask(() => {
        if (listeners?.has(listener)) {
          listener();
        }
      });
    }
  }

  /**
   * Получает receipt либо применяет сохранённый пакет; ошибка чтения receipt не
   * доказывает отсутствие commit, даже если сервер ответил 4xx.
   */
  async function send(project: string, key: string, operation: PendingWrite): Promise<BatchResult> {
    try {
      if (!operation.request) {
        const context = await client.context();
        operation.request = {
          commands: operation.commands,
          actor: context.data.actor,
          operationKey: operation.operationKey,
        };
      }
      if (operation.uncertain) {
        try {
          const receipt = await client.receipt(project, operation.operationKey);
          pending.delete(key);
          return receipt.data;
        } catch (error) {
          if (
            !(error instanceof RelayApiError) ||
            error.status !== 404 ||
            error.code !== "NOT_FOUND"
          ) {
            throw new UncertainWriteError(dataMessages.unknown, { cause: error });
          }
        }
      }
      operation.uncertain = true;
      const result = await client.batch(project, operation.request);
      pending.delete(key);
      return result.data;
    } catch (error) {
      if (
        !operation.uncertain ||
        (error instanceof RelayApiError &&
          error.status > 0 &&
          error.status < 500 &&
          error.code !== "INVALID_RESPONSE")
      ) {
        pending.delete(key);
        throw error;
      }
      if (error instanceof UncertainWriteError) {
        throw error;
      }
      throw new UncertainWriteError(dataMessages.unknown, { cause: error });
    }
  }

  /**
   * Делит уже начатое восстановление между формой и общим уведомлением.
   * Снимок появляется только после неопределённого отказа, а не первого POST.
   */
  function run(project: string, key: string, operation: PendingWrite): Promise<BatchResult> {
    if (operation.running) {
      return operation.running;
    }
    operation.running = send(project, key, operation).finally(() => {
      operation.running = undefined;
      if (pending.get(key) === operation && operation.uncertain) {
        operation.recovery = Object.freeze({
          operationKey: operation.operationKey,
          recovering: false,
        });
        notify(key);
      } else if (operation.recovery) {
        notify(key);
      }
    });
    if (operation.recovery) {
      operation.recovery = Object.freeze({
        operationKey: operation.operationKey,
        recovering: true,
      });
      notify(key);
    }
    return operation.running;
  }

  /**
   * Возвращает стабильный снимок для useSyncExternalStore без сетевого запроса.
   * Обычный активный submit, его успешный исход и достоверный отказ не создают alert.
   */
  function getPendingWrite(project: string): PendingWriteRecovery | null {
    return pending.get(scopeKey(project))?.recovery ?? null;
  }

  /**
   * Подписывает уведомление на текущие origin/project без владения самой операцией.
   * Отписка при unmount не отменяет запрос и не удаляет возможность его восстановления.
   */
  function subscribePendingWrite(project: string, onChange: () => void): () => void {
    const key = scopeKey(project);
    let listeners = subscriptions.get(key);
    if (!listeners) {
      listeners = new Set();
      subscriptions.set(key, listeners);
    }
    const registered = listeners;
    registered.add(onChange);
    return () => {
      registered.delete(onChange);
      if (registered.size === 0 && subscriptions.get(key) === registered) {
        subscriptions.delete(key);
      }
    };
  }

  /**
   * Явно проверяет исходную receipt; только NOT_FOUND допускает отправку frozen request.
   * Не принимает новый ввод, не читает context и не создаёт operationKey. Устаревшее
   * уведомление возвращает null без I/O и не может восстановить другую новую операцию.
   * Достоверный отказ снимает блокировку и пробрасывается; сетевой сохраняет recovery.
   */
  async function recoverPendingWrite(
    project: string,
    operationKey: string,
  ): Promise<BatchResult | null> {
    const key = scopeKey(project);
    const operation = pending.get(key);
    if (!operation?.recovery || operation.operationKey !== operationKey) {
      return null;
    }
    return run(project, key, operation);
  }

  /**
   * Регистрирует исходный ввод до I/O; повтор не меняет автора, ключ и guards операции.
   */
  async function write(
    project: string,
    commands: readonly NamedCommand[],
    operationKey?: string,
  ): Promise<BatchResult> {
    const snapshot = structuredClone(commands);
    const key = scopeKey(project);
    const fingerprint = JSON.stringify(snapshot);
    let operation = pending.get(key);
    if (operation && operation.fingerprint !== fingerprint) {
      throw new UncertainWriteError(dataMessages.changedInput);
    }
    if (!operation) {
      operation = {
        commands: snapshot,
        operationKey: operationKey ?? crypto.randomUUID(),
        fingerprint,
        uncertain: false,
      };
      pending.set(key, operation);
    }
    return run(project, key, operation);
  }

  return Object.assign(write, { getPendingWrite, subscribePendingWrite, recoverPendingWrite });
}
