/**
 * Самостоятельная справка и процессные диагностики Server.
 */
export const processMessages = {
  arguments: "Некорректные параметры relay-server; используйте --help",
  launchConflict: "--launch несовместим с --config/--home/--project/--actor/--port",
  lease: "--parent-lease допустим только с foreground --launch",
  version: "Версия launch не совпадает с версией relay-server",
  timeout: "Relay Server не завершил текущие операции в пределах shutdown deadline",
  failed: "Не удалось выполнить запуск Relay Server",
  help: `Relay Server — локальные REST API и Web

relay-server [run] [--config PATH] [--home PATH] [--project NAME]
             [--actor AUTHOR] [--port NUMBER] [--allow-origin ORIGIN]
relay-server run --launch PATH [--parent-lease]

Прямой запуск регистрируется в Runtime как foreground. Порт по умолчанию 3210;
--port 0 выделяет свободный loopback-порт. Автор: --actor, RELAY_ACTOR, затем web.
Конфигурация: --config, RELAY_CONFIG; home: --home, RELAY_HOME.
Dev frontend: --allow-origin (повторяемый) либо RELAY_WEB_ORIGIN, например
http://127.0.0.1:5173. Vite proxy использует changeOrigin:true.
SIGINT/SIGTERM завершают SSE, ожидают текущие записи и свои процессные запросы.
--parent-lease читает stdin только для foreground --launch; EOF означает остановку.
Фоновый запуск и реестр: relay server start/list/stop/restart.

--help, -h  Автономная справка без проекта
--version   Автономная версия без проекта
`,
} as const;
