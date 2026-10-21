/**
 * Переносимая ошибка Relay со стабильным кодом для программной обработки.
 * Сообщение предназначено пользователю, exitCode — вызывающему интерфейсу CLI.
 */
export class RelayError extends Error {
  /* Стабильный код причины отказа, не зависящий от текста сообщения. */
  readonly code: string;
  /* Код завершения CLI; по умолчанию 1 для общей ошибки выполнения. */
  readonly exitCode: number;
  /* Структурированные сведения об отказе; свойство отсутствует без дополнительных данных. */
  readonly details?: Record<string, unknown>;

  /**
   * Создаёт ошибку без преобразования сообщения и дополнительных сведений.
   * Объект details сохраняется по ссылке; конструктор его не изменяет.
   */
  constructor(
    code: string,
    message: string,
    exitCode = 1,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "RelayError";
    this.code = code;
    this.exitCode = exitCode;
    if (details !== undefined) {
      this.details = details;
    }
  }
}
