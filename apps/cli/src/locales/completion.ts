/**
 * Справка и диагностика подключения shell completion.
 */
export const completionMessages = {
  help: {
    description: "Подключить автодополнение команд, параметров и перечислений",
    details:
      "Печатает скрипт подключения для выбранной оболочки. Для Bash нужен подключённый bash-completion: сохраните вывод relay complete bash в ~/.local/share/bash-completion/completions/relay и выполните source этого файла. Для остальных оболочек подключите скрипт их средствами.\n\nПосле пересборки Bash получает подсказки от relay из PATH. После переноса бинарника пересоздайте скрипты Zsh, Fish и PowerShell. Генерация и запрос кандидатов работают без проекта и чтения stdin. Вывод — shell-скрипт или служебный протокол, включая вызов с --format json.",
    examples: [
      { description: "Получить скрипт Bash", command: "relay complete bash" },
      { description: "Получить скрипт Zsh", command: "relay complete zsh" },
      { description: "Получить скрипт Fish", command: "relay complete fish" },
      { description: "Получить скрипт PowerShell", command: "relay complete powershell" },
    ],
  },
  shell: "Оболочка: bash, zsh, fish или powershell",
  invalidRequest:
    "Укажите одну оболочку: relay complete <shell>; запрос кандидатов: relay complete -- <слова>",
  missingCommand: "Плагин Gunshi не зарегистрировал команду complete",

  /**
   * Объясняет отказ генерации скрипта для неизвестной оболочки.
   */
  unsupportedShell: (shell: string, supported: readonly string[]): string =>
    `Неизвестная оболочка «${shell}»: выберите ${supported.join(", ")}`,
} as const;
