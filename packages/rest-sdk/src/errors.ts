import type { HttpError } from "@relay/contracts";

/**
 * Предметный отказ HTTP; исходный код и детали доступны без разбора текста.
 */
export class RelayApiError extends Error {
  /* HTTP status ответа; 0 означает локальный отказ до получения HTTP-ответа. */
  readonly status: number;
  /* Стабильный код отказа. */
  readonly code: string;
  /* Исходные дополнительные сведения. */
  readonly details: Readonly<Record<string, unknown>> | undefined;

  /**
   * Сохраняет исходную диагностику без нормализации значений.
   */
  constructor(error: HttpError, status: number, cause?: unknown) {
    super(error.message, cause === undefined ? undefined : { cause });
    this.name = "RelayApiError";
    this.code = error.code;
    this.details = error.details;
    this.status = status;
  }
}
