/**
 * Платформенная граница Git shell и распознавания remote. Пользовательские SSH overrides
 * не проходят через этот encoder: адаптер кодирует только собственные контролируемые argv.
 */
export interface GitPlatform {
  /* Путь отключения Git hooks в синтаксисе конкретной поставки Git. */
  readonly disabledHooksPath: string;
  /**
   * Отличает SSH URL/scp remote от локального пути и других протоколов.
   */
  usesSsh(remote: string): boolean;
  /**
   * Кодирует одно собственное слово для shell, используемого Git alias/sshCommand.
   */
  shellWord(value: string): string;
}
