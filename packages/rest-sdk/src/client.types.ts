import type {
  BatchResult,
  GitSyncControlOutcome,
  HttpBatchRequest,
  HttpCommandRequest,
  HttpEntityPage,
  HttpEntityQuery,
  HttpMeta,
  HttpOverview,
  HttpReadParameters,
  HttpReadResults,
  HttpProjectEvent,
  ProjectEntity,
  ServerContext,
} from "@relay/contracts";

/**
 * Успешный ответ SDK; metadata исходного чтения доступна вместе с data.
 */
export interface RelayResponse<T> {
  /* Успешный discriminator HTTP-оболочки. */
  readonly ok: true;
  /* Точный DTO выбранного действия. */
  readonly data: T;
  /* Исходные версии и поколение согласованного чтения. */
  readonly meta?: HttpMeta;
}

/**
 * Настройки браузерного Fetch-клиента.
 */
export interface RelayClientOptions {
  /* Origin сервера без /api/v2; пустая строка означает текущий origin браузера. */
  readonly baseUrl?: string;
  /* Подмена fetch для интеграции; глобальное окружение не изменяется. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Точный HTTP-клиент. Ошибки представлены RelayApiError; мутации не повторяются автоматически.
 */
export interface RelayClient {
  /* Режим сервера, все регистрации и начальное значение автора форм. */
  readonly context: () => Promise<RelayResponse<ServerContext>>;
  /* Карточка по ID/ключу; withVersions сохраняет исходные tokens в meta.versions. */
  readonly entity: (
    projectId: string,
    ref: string,
    options?: { readonly withVersions?: boolean },
  ) => Promise<RelayResponse<ProjectEntity>>;
  /* Страница вида; продолжение требует generation предыдущего ответа. */
  readonly entities: (
    projectId: string,
    query: HttpEntityQuery,
  ) => Promise<RelayResponse<HttpEntityPage>>;
  /* Одна NamedCommand с явным автором, operationKey и исходными guards. */
  readonly command: (
    projectId: string,
    command: HttpCommandRequest,
  ) => Promise<RelayResponse<BatchResult>>;
  /* Атомарный пакет текущих команд с необязательным check/rollback. */
  readonly batch: (
    projectId: string,
    batch: HttpBatchRequest,
  ) => Promise<RelayResponse<BatchResult>>;
  /* Первоначальный результат без повторного исполнения; operationKey передаётся дословно в query. */
  readonly receipt: (
    projectId: string,
    operationKey: string,
  ) => Promise<RelayResponse<BatchResult>>;
  /* Компактные текущие агрегаты Core одного snapshot. */
  readonly overview: (projectId: string) => Promise<RelayResponse<HttpOverview>>;
  /* Именованная проекция; ключ определяет точные параметры и возвращаемый DTO. */
  readonly read: <K extends keyof HttpReadResults>(
    projectId: string,
    operation: K,
    parameters: HttpReadParameters[K],
  ) => Promise<RelayResponse<HttpReadResults[K]>>;
  /* Явный Runtime now; повторный вызов создаёт новую сетевую операцию. */
  readonly gitSyncNow: (projectId: string) => Promise<RelayResponse<GitSyncControlOutcome>>;
  /* Адрес SSE для самостоятельно управляемого EventSource. */
  readonly eventsUrl: (projectId: string) => string;
  /* Подписка на invalidation; возвращает функцию закрытия EventSource. */
  readonly subscribe: (
    projectId: string,
    listener: (event: HttpProjectEvent) => void,
    onError?: () => void,
  ) => () => void;
}
