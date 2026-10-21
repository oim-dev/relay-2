/**
 * Справка и диагностика подключения shell completion.
 */
export const completionMessages = {
  description: "Подключить автодополнение команд, параметров и перечислений",
  shell: "Оболочка: bash, zsh, fish или powershell",
  examples: "relay complete bash\nrelay complete zsh\nrelay complete fish",
  invalidRequest:
    "Укажите одну оболочку: relay complete <shell>; запрос кандидатов: relay complete -- <слова>",
  missingCommand: "Плагин Gunshi не зарегистрировал команду complete",

  /**
   * Объясняет отказ генерации скрипта для неизвестной оболочки.
   */
  unsupportedShell: (shell: string, supported: readonly string[]): string =>
    `Неизвестная оболочка «${shell}»: выберите ${supported.join(", ")}`,
} as const;
