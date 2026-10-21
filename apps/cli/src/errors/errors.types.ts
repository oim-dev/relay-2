/**
 * Диагностика валидации Gunshi, связанная с конкретным экземпляром AggregateError.
 * Идентичность ошибки исключает применение сообщения к другому параллельному вызову.
 */
export interface ValidationFailure {
  /* Исходная ошибка разбора Gunshi текущего запуска. */
  readonly error: AggregateError;
  /* Локализованное сообщение renderer Gunshi, включая сведения о неверных параметрах. */
  readonly message: string;
}

/**
 * Нормализованный отказ на границе runCli, независимый от способа текстового представления.
 */
export interface CliFailure {
  /* Стабильный машинный код Relay либо INTERNAL_ERROR для неожиданного отказа. */
  readonly code: string;
  /* Диагностика без терминальной очистки; JSON сохраняет её дословно. */
  readonly message: string;
  /* Код завершения: исходный RelayError либо 1/2 для внутреннего отказа/синтаксиса. */
  readonly exitCode: number;
  /* Признак ошибки ввода, требующей дополнительной подсказки справки в text-режиме. */
  readonly invalidInput: boolean;
  /* Структурированные сведения RelayError; отсутствие не заменяется пустым объектом. */
  readonly details?: Record<string, unknown>;
}
