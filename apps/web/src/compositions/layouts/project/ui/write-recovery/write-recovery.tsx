import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useSWRConfig } from "swr";
import { getPendingWrite, subscribePendingWrite, recoverPendingWrite } from "domains/relay-data";
import type {
  WriteRecoveryEffects,
  WriteRecoveryFailure,
  WriteRecoveryProps,
} from "./types/write-recovery-props.type";
import { writeRecoveryMessages as messages } from "./write-recovery.messages";

/**
 * Выбирает область существующих ключей [domain, projectId, ...] и
 * [domain, origin, projectId, ...]. Совпавший ref/filter другого проекта не является владельцем.
 * Ключи первого вида уже изолированы origin через DataProvider.
 */
export function isRecoveryProjectKey(key: unknown, projectId: string, origin: string): boolean {
  return (
    Array.isArray(key) && (key[1] === projectId || (key[1] === origin && key[2] === projectId))
  );
}

/**
 * Связывает явное действие уведомления с публичным recovery API без нового ввода.
 * Запись и последующее чтение имеют разные границы отказа. Поздний результат обновляет
 * только исходный GET-кеш, но не уведомление другого mount или более новой операции.
 */
export async function recoverWriteNotification(
  projectId: string,
  operationKey: string,
  origin: string,
  effects: WriteRecoveryEffects,
): Promise<void> {
  const initial = getPendingWrite(projectId);
  if (!effects.isActive() || initial?.operationKey !== operationKey || initial.recovering) {
    return;
  }
  effects.started();
  let result: Awaited<ReturnType<typeof recoverPendingWrite>>;
  try {
    result = await recoverPendingWrite(projectId, operationKey);
  } catch (error) {
    if (!effects.isActive()) {
      return;
    }
    const current = getPendingWrite(projectId);
    const message = error instanceof Error ? error.message : String(error);
    if (current === null) {
      effects.rejected(message);
    } else if (current.operationKey === operationKey) {
      effects.uncertain(message);
    }
    return;
  }
  if (result === null) {
    return;
  }
  try {
    await effects.refresh((key) => isRecoveryProjectKey(key, projectId, origin));
  } catch {
    // Подтверждённая запись не меняет исход из-за GET: его ошибкой владеет SWR соответствующего ключа.
  }
  if (effects.isActive() && getPendingWrite(projectId) === null) {
    effects.confirmed();
  }
}

/**
 * Показывает существующим механизмом уведомлений действие для неопределённой записи.
 * Обычные экраны не получают дополнительных контейнеров. Уход из проекта скрывает
 * уведомление; возврат восстанавливает его по состоянию владельца операции.
 * Используется для проверки receipt после закрытия первоначального редактора.
 */
export const WriteRecovery = ({ projectId, projectName }: WriteRecoveryProps): null => {
  const { mutate } = useSWRConfig();
  /**
   * Удерживает подписку только на выбранный проект; смена проекта освобождает старую.
   */
  const subscribe = useCallback(
    (onChange: () => void): (() => void) => subscribePendingWrite(projectId, onChange),
    [projectId],
  );
  /**
   * Читает стабильный immutable snapshot, не вызывая HTTP из render.
   */
  const snapshot = useCallback(
    (): ReturnType<typeof getPendingWrite> => getPendingWrite(projectId),
    [projectId],
  );
  const pending = useSyncExternalStore(subscribe, snapshot, () => null);
  const id = `relay-write-recovery:${projectId}`;
  const origin = globalThis.location?.origin ?? "";
  const lifetime = useRef<symbol | null>(null);
  const [failure, setFailure] = useState<WriteRecoveryFailure | null>(null);
  useLayoutEffect(() => {
    // Синхронный cleanup закрывает окно позднего ответа до пассивных effects нового проекта.
    const token = Symbol();
    lifetime.current = token;
    return () => {
      if (lifetime.current === token) {
        lifetime.current = null;
      }
      notifications.hide(id);
    };
  }, [id]);
  useEffect(() => {
    const token = lifetime.current;
    if (token === null) {
      return;
    }
    if (pending === null) {
      notifications.hide(id);
      setFailure(null);
      return;
    }
    const operationKey = pending.operationKey;
    /**
     * Устаревшая кнопка не подтверждает новую операцию. Успех инвалидирует только
     * исходный проект и не заменяет guards или значения открытых форм.
     */
    const recover = async (): Promise<void> => {
      await recoverWriteNotification(projectId, operationKey, origin, {
        /**
         * Проверяет именно экземпляр исходного каркаса, включая A→B→A и StrictMode.
         */
        isActive: (): boolean => lifetime.current === token,
        /**
         * Убирает прежнюю ошибку этой операции перед явным повтором.
         */
        started: (): void => setFailure(null),
        /**
         * Передаёт scoped-предикат общему кешу чтения.
         */
        refresh: (matches): Promise<unknown> => mutate(matches),
        /**
         * Закрывает только разрешённое уведомление; новый pending уже проверен оркестратором.
         */
        confirmed: (): void => {
          notifications.hide(id);
          notifications.show({
            id: `${id}:${operationKey}:confirmed`,
            title: projectName,
            message: messages.confirmed,
          });
        },
        /**
         * Показывает достоверный отказ с идентичностью первоначальной операции.
         */
        rejected: (message): void => {
          notifications.show({
            id: `${id}:${operationKey}:rejected`,
            title: messages.rejected(projectName),
            message,
            autoClose: false,
          });
        },
        /**
         * Сохраняет диагностику только для того же operationKey.
         */
        uncertain: (message): void => setFailure({ operationKey, message }),
      });
    };
    const notification = {
      id,
      title: messages.title(projectName),
      autoClose: false as const,
      withCloseButton: false,
      message: (
        <Stack gap="xs">
          <Text size="sm">
            {failure?.operationKey === operationKey ? failure.message : messages.message}
          </Text>
          <Button
            variant="default"
            size="xs"
            loading={pending.recovering}
            onClick={() => void recover()}
          >
            {messages.action}
          </Button>
        </Stack>
      ),
    };
    notifications.show(notification);
    notifications.update(notification);
  }, [id, projectId, projectName, pending, mutate, failure, origin]);
  return null;
};
