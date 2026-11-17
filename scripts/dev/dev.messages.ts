/**
 * Справка и сообщения общего dev-запуска.
 */
export const developmentMessages = {
  help: `Relay dev — CLI watch, API из исходников и Vite

Из корня checkout:
  bun run dev -- --playground ../playground

  --playground DIR  Существующий проект/workspace (по умолчанию ../playground)
  --home DIR        Relay home: флаг, RELAY_HOME, затем ../.relay-home от playground
  --actor AUTHOR    Автор Web: флаг, RELAY_ACTOR, затем web
  --port NUMBER     Порт API (по умолчанию 3210)
  --web-port NUMBER Порт Vite (по умолчанию 5174)
  --help            Показать эту справку

Пути флагов разрешаются от текущего каталога. Проекты и базы должны быть подготовлены.
Dev не выполняет .envrc: окружение direnv передайте из терминала либо задайте --home.
Ctrl+C завершает CLI watcher, Server и Vite. Данные playground сохраняются.
`,
  arguments: "Некорректные параметры dev; используйте bun run dev -- --help",
  unavailable: "В выбранном playground нет доступных проектов; проверьте конфигурацию и --home",
  stopped: "Dev-сессия завершена.",
  managed: "Управление: этот терминал; Ctrl+C завершает dev-сессию.",
  preparing: "Подготовка CLI и REST SDK…",
  starting: "Запуск CLI watch, Server и Vite…",
  /**
   * Печатает согласованный контекст, которым пользуются все dev-процессы.
   */
  context: (config: string, home: string, cli: string): string =>
    `Workspace: ${config}\nRELAY_HOME: ${home}\nCLI: ${cli}`,
  /**
   * Отделяет проверенную готовность от объявления планируемых адресов до bind.
   */
  ready: (instanceId: string, apiUrl: string, webUrl: string): string =>
    `Dev готов [${instanceId}]\nAPI: ${apiUrl}\nWeb: ${webUrl}`,
  /**
   * Любой самостоятельный выход persistent-команды завершает согласованную сессию.
   */
  exited: (name: string, code: number): string => `${name}: процесс завершился с кодом ${code}`,
  /**
   * Ошибка начальной готовности сохраняет имя проверяемого компонента.
   */
  readiness: (name: string): string => `${name}: не подтверждена готовность dev-процесса`,
};
