import type { BatchResult } from "../batch/batch.types";
import type { ProjectEntity } from "../project-entity.types";
import type { GitSyncControlOutcome } from "../replication/git-sync-control.types";
import type {
  HttpBatchRequest,
  HttpCommandRequest,
  HttpEntityPage,
  HttpOverview,
  HttpResponse,
  HttpProjectEvent,
  ServerContext,
} from "./http.types";
import type { HttpReadResults } from "./read.types";

/**
 * Именованные схемы генератора OpenAPI. Корень доступен без Runtime, Core и открытия БД.
 */
export type HttpApiSchemas = {
  /* Ответ контекста сервера. */
  readonly context: HttpResponse<ServerContext>;
  /* Ответ одной пользовательской карточки. */
  readonly entity: HttpResponse<ProjectEntity>;
  /* Ответ согласованной страницы. */
  readonly entities: HttpResponse<HttpEntityPage>;
  /* Первоначальная квитанция одиночной команды. */
  readonly command: HttpResponse<BatchResult>;
  /* Квитанция атомарного пакета либо проверки. */
  readonly batch: HttpResponse<BatchResult>;
  /* Чтение первоначального результата без повторной mutation. */
  readonly receipt: HttpResponse<BatchResult>;
  /* Компактная проекция текущего обзора Core. */
  readonly overview: HttpResponse<HttpOverview>;
  /* Принятый либо законченный исход явного Runtime now. */
  readonly gitSyncNow: HttpResponse<GitSyncControlOutcome>;
  /* Транспортная форма одиночной записи. */
  readonly commandRequest: HttpCommandRequest;
  /* Транспортная форма атомарного пакета. */
  readonly batchRequest: HttpBatchRequest;
  /* Явный now не принимает Runtime options от браузера. */
  readonly gitSyncNowRequest: Record<string, never>;
  /* JSON payload каждого кадра SSE. */
  readonly projectEvent: HttpProjectEvent;
} & { readonly [K in keyof HttpReadResults]: HttpResponse<HttpReadResults[K]> };
