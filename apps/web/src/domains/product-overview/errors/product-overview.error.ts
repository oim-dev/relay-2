/** Коды неуспешного чтения обзора проекта. */
export const PRODUCT_OVERVIEW_ERROR_CODE = {
  PROJECT_UNAVAILABLE: "PRODUCT_OVERVIEW_PROJECT_UNAVAILABLE",
  STORAGE_FAILURE: "PRODUCT_OVERVIEW_STORAGE_FAILURE",
  STORAGE_MAINTENANCE: "PRODUCT_OVERVIEW_STORAGE_MAINTENANCE",
  INVALID_RESPONSE: "PRODUCT_OVERVIEW_INVALID_RESPONSE",
  TEMPORARILY_UNAVAILABLE: "PRODUCT_OVERVIEW_TEMPORARILY_UNAVAILABLE",
  SNAPSHOT_CHANGED: "PRODUCT_OVERVIEW_SNAPSHOT_CHANGED",
} as const;

/** Предметные данные неуспешного чтения обзора. */
export type ProductOverviewErrorDetails =
  | Readonly<{ code: typeof PRODUCT_OVERVIEW_ERROR_CODE.PROJECT_UNAVAILABLE }>
  | Readonly<{
      code: typeof PRODUCT_OVERVIEW_ERROR_CODE.STORAGE_FAILURE;
      payload: Readonly<{ message: string }>;
    }>
  | Readonly<{
      code: typeof PRODUCT_OVERVIEW_ERROR_CODE.STORAGE_MAINTENANCE;
      payload: Readonly<{ message: string }>;
    }>
  | Readonly<{ code: typeof PRODUCT_OVERVIEW_ERROR_CODE.INVALID_RESPONSE }>
  | Readonly<{ code: typeof PRODUCT_OVERVIEW_ERROR_CODE.SNAPSHOT_CHANGED }>
  | Readonly<{ code: typeof PRODUCT_OVERVIEW_ERROR_CODE.TEMPORARILY_UNAVAILABLE }>;

export class ProductOverviewDomainError extends Error {
  readonly name = "ProductOverviewDomainError";

  constructor(
    readonly details: ProductOverviewErrorDetails,
    options?: ErrorOptions,
  ) {
    super(`product-overview:${details.code}`, options);
  }
}

/** Ошибка чтения обзора проекта. */
export type GetProductOverviewError = ProductOverviewDomainError;

/** Проект недоступен или не найден сервером. */
export const createProjectUnavailableError = (cause?: unknown): GetProductOverviewError =>
  new ProductOverviewDomainError(
    { code: PRODUCT_OVERVIEW_ERROR_CODE.PROJECT_UNAVAILABLE },
    { cause },
  );

/** Сервер не смог прочитать хранилище проекта. */
export const createStorageFailureError = (message: string): GetProductOverviewError =>
  new ProductOverviewDomainError({
    code: PRODUCT_OVERVIEW_ERROR_CODE.STORAGE_FAILURE,
    payload: { message },
  });

/**
 * Хранилище проекта несовместимо или требует обслуживания: чтение не выполнено,
 * пустой обзор не показывается, автоматический повтор не нужен.
 */
export const createStorageMaintenanceError = (
  message: string,
  cause: unknown,
): GetProductOverviewError =>
  new ProductOverviewDomainError(
    { code: PRODUCT_OVERVIEW_ERROR_CODE.STORAGE_MAINTENANCE, payload: { message } },
    { cause },
  );

/** Ответ сервера не соответствует контракту обзора; его нельзя показывать нулями. */
export const createInvalidResponseError = (cause?: unknown): GetProductOverviewError =>
  new ProductOverviewDomainError({ code: PRODUCT_OVERVIEW_ERROR_CODE.INVALID_RESPONSE }, { cause });

/** Сервер временно недоступен или ответ не получен. */
export const createTemporarilyUnavailableError = (cause?: unknown): GetProductOverviewError =>
  new ProductOverviewDomainError(
    { code: PRODUCT_OVERVIEW_ERROR_CODE.TEMPORARILY_UNAVAILABLE },
    { cause },
  );

/**
 * Составной снимок изменился; частичные данные не публикуются.
 */
export const createSnapshotChangedError = (cause?: unknown): GetProductOverviewError =>
  new ProductOverviewDomainError({ code: PRODUCT_OVERVIEW_ERROR_CODE.SNAPSHOT_CHANGED }, { cause });
