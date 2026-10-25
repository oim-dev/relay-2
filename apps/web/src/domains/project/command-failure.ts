import { RelayApiError } from "infra/relay-api";

/**
 * Отказ команды отдельно сообщает, известен ли её предметный исход.
 */
export class CommandFailure extends Error {
  /* Стабильный код сервера либо NETWORK_ERROR. */
  readonly code: string;
  /* true запрещает новый operationKey до проверки первоначальной квитанции. */
  readonly uncertain: boolean;
  /* Подробности сохраняются для адресного сообщения формы. */
  readonly details: Readonly<Record<string, unknown>> | undefined;

  /**
   * Сохраняет исходную диагностику без потери признака неопределённого результата.
   */
  constructor(
    code: string,
    message: string,
    uncertain: boolean,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "CommandFailure";
    this.code = code;
    this.uncertain = uncertain;
    this.details = details;
  }
}

/**
 * Определяет необходимость сохранить frozen запрос для проверки квитанции.
 */
export function isUncertainCommandError(error: unknown): boolean {
  return error instanceof CommandFailure && error.uncertain;
}

/**
 * Показывает исходную ошибку, не превращая неожиданную поломку в пустое состояние.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Классифицирует сетевой/серверный обрыв консервативно: запись могла состояться.
 */
export function commandFailure(error: unknown): CommandFailure {
  if (error instanceof RelayApiError) {
    const uncertain =
      error.status === 0 || error.status >= 500 || error.code === "INVALID_RESPONSE";
    return new CommandFailure(error.code, error.message, uncertain, error.details);
  }
  return new CommandFailure("NETWORK_ERROR", errorMessage(error), true);
}
