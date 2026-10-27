import { useMemo, type ReactElement } from "react";
import { SWRConfig, type Cache } from "swr";
import { isStorageFailure } from "infra/tasks-api";
import type { DataProviderProps } from "./types/data-provider-props.type";

/**
 * Задаёт политику общего кеша чтения REST.
 *
 * Используется для:
 *  - дедупликации запросов и ограниченного восстановления после сетевой ошибки
 *  - отказа от автоматического повтора, когда хранилище проекта требует обслуживания
 */
export const DataProvider = (props: DataProviderProps): ReactElement => {
  const origin = typeof location === "undefined" ? "" : location.origin;
  // Origin задаёт отдельное пространство ключей; projectId остаётся в ключах доменных hooks.
  // Не используем глобальный кеш SWR: другая корневая область не получает старую карточку.
  const cache = useMemo<Cache>(() => new Map(), [origin]);
  return (
    <SWRConfig
      key={origin}
      value={{
        /**
         * Удерживает одно пространство GET-кеша на время жизни текущего origin.
         */
        provider: () => cache,
        dedupingInterval: 500,
        errorRetryCount: 2,
        errorRetryInterval: 3000,
        /**
         * Отказ хранилища требует действия пользователя, а не автоматического повтора.
         */
        shouldRetryOnError: (error: Error) => !isStorageFailure(error),
        revalidateOnFocus: true,
      }}
    >
      {props.children}
    </SWRConfig>
  );
};
