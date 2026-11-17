# Dev-режим с внешним playground

Dev-запуск соединяет исходники checkout с существующими проектами playground.
CLI пересобирается в самостоятельный бинарник, Server исполняется под Bun с watch,
а Web обслуживается Vite под Node.js с HMR. API использует те же базы и Git-репозитории,
что CLI из терминала playground.

## Первый запуск

Нужны версии Bun и Node.js из [быстрого старта](../../README.md#быстрый-старт),
установленные зависимости и подготовленный playground с существующими базами.
Стандартная раскладка:

```text
relay/
├── relay-2/       # checkout исходников
├── playground/   # relay.workspace.json и самостоятельные проекты
└── .relay-home/  # хранилища проектов и реестр Server
```

Из корня `relay-2`:

```sh
bun install --frozen-lockfile
bun run dev -- --playground ../playground
```

Команда готовит CLI и vendor-часть REST SDK, затем запускает CLI watch, Server из
исходников и Vite. Production-сборки Web и Server для этого не нужны. После проверки
готовности в терминале появляются адреса API и Web, UUID экземпляра, выбранные
конфигурация и home, путь к CLI. Откройте **http://127.0.0.1:5174**.

Playground выбирается по `--playground`, по умолчанию `../playground` относительно
каталога запуска. Можно указать корень одного проекта вместо workspace.
Home выбирается из `--home`, затем `RELAY_HOME`, затем соседнего с playground
каталога `.relay-home`. Пути флагов разрешаются от каталога запуска.
Автор Web — `--actor`, `RELAY_ACTOR`, затем `web`.

При выборе вложенного проекта стандартного playground передайте общий home явно,
если он ещё не задан окружением:

```sh
bun run dev -- --playground ../playground/projects/commerce --home ../.relay-home
```

```sh
bun run dev -- --playground ../playground --home ../.relay-home \
  --port 3210 --web-port 5174 --actor developer
```

Оба порта фиксированы и должны различаться. Занятый порт вызывает отказ. Другие
адреса API, Vite proxy и разрешённый Origin согласуются launcher автоматически.
Он передаёт Server путь к CLI текущего checkout, а не выбирает случайную сборку из PATH.

Dev-запуск не исполняет `.envrc`. При использовании direnv передайте окружение
из терминала playground либо задайте `--home` явно. Инициализация проектов,
восстановление баз и настройка Git выполняются по [README playground](https://github.com/oim-dev/relay-playground).
Повторный запуск сохраняет существующие данные. Git Sync работает в обычном режиме
проектов, включая их текущие remote и настройки автоматического обмена.

## Цикл разработки

- **CLI и общие пакеты:** watcher обновляет `apps/cli/dist/relay`; следующая команда
  из playground использует новую сборку. В стандартной среде `~/.local/bin/relay`
  ссылается на этот файл. Путь можно проверить через `relay status`.
- **Server и импортируемые пакеты:** Bun перезапускает исходный сервер. UUID dev-сессии
  сохраняется, конкретный запуск получает новый `bootId`.
- **Web:** Vite обновляет интерфейс через HMR.
- **HTTP-контракт:** после изменения DTO/маршрутов выполните `bun run generate:api`.
  Генерация обновляет OpenAPI, SDK и его compiled vendor output; обычные правки UI
  или реализации Server этого шага не требуют.
- **Состав workspace:** перезапустите dev-сессию, чтобы Server перечитал регистрации.

Для остановки нажмите Ctrl+C в терминале dev-запуска. Launcher завершает собственные
процессы и ожидает их очистку. Выход одной persistent-команды завершает всю сессию.
SIGTERM и потеря внешнего процесса `bun run dev` также запускают эту очистку: координатор
наблюдает своего исходного родителя, а существующие Runtime guardians владеют деревьями компонентов.

## Диагностика

В другом терминале, с тем же `RELAY_HOME`:

```sh
relay status
relay server list
relay server open
```

`relay status` показывает всё локальное состояние home; подробности — в
[руководстве CLI](../CLI.md#общее-состояние-relay).
Серверный статус отмечает dev-экземпляр `[dev]`: `url` в JSON — адрес API,
`development.webUrl` — адрес Vite. `server open` открывает Vite; при нескольких
готовых экземплярах нужен `--instance UUID`.

`server stop/restart` для dev возвращают `SERVER_DEVELOPMENT_MANAGED` с кодом 4:
управление принадлежит терминалу. Отметка dev не подменяет health: после аварии
сохранившийся endpoint становится `stale`, занятое владение без health — `unresponsive`.
Обычное завершение оставляет регистрацию `stopped`.

Полная упаковка `bun run build:cli` и проверки по [руководству CI](CI.md) используются
для приёмки поставки с Web внутри Server.
