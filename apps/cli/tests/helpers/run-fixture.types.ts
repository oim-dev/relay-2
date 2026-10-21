/**
 * Полные потоки и код завершения одного запуска runCli.
 */
export interface InvocationResult {
  /* Код завершения команды; ноль означает успех. */
  readonly exitCode: number;

  /* Полный текст стандартного вывода текущего вызова. */
  readonly stdout: string;

  /* Полный текст диагностического вывода текущего вызова. */
  readonly stderr: string;
}

/**
 * Зарегистрированный маршрут команды для независимой проверки справки.
 */
export interface CommandRoute {
  /* Читаемый путь команды, отображаемый в названии тестового случая. */
  readonly name: string;

  /* Имена вложенных команд от корня до проверяемого узла. */
  readonly argv: readonly string[];
}
