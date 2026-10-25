# Разработка Web

Документ описывает окружение, источники правил, генерацию компонентов и проверку
пользовательского результата. Владельцы кода находятся в [архитектуре](ARCHITECTURE.md),
обязательные локальные правила — в [AGENTS.md](../AGENTS.md).

## Окружение и запуск

Установите workspace по [корневому README](../../../README.md#быстрый-старт).
Bun управляет зависимостями и командами монорепозитория; **Vite выполняется под Node.js**.
Для разработки используйте Node.js 24. Точные зависимости и команды закреплены в
[package.json](../package.json), браузерный профиль TypeScript — в [tsconfig.json](../tsconfig.json).

Подготовьте собственный инициализированный проект/workspace и запустите его Server.
API не создаёт тестовую базу вместо отсутствующей. Параметры контекста и пример
асинхронного `startRelayServer` для NestJS/Fastify находятся в
[Server README](../../server/README.md#встраивание-и-жизненный-цикл).
Для Vite явно разрешите origin разработки в bootstrap Server; не отключайте проверку
Host/Origin ради dev-прокси.

Например, если Server слушает `127.0.0.1:3210`, а Web — `127.0.0.1:5173`, прокси с
`changeOrigin: true` передаёт серверу Host `127.0.0.1:3210`. Порт Vite не добавляется
в список серверных Host. Разрешённый dev origin — `http://127.0.0.1:5173`; при смене
адреса Web согласуйте его с bootstrap сервера.
Затем из `apps/web`:

```bash
RELAY_API_URL=http://127.0.0.1:3210 bun run dev --port 5173 --strictPort
```

Откройте адрес, напечатанный Vite. Браузер обращается к `/api` своего origin, Vite
проксирует этот путь к `RELAY_API_URL`. Без переменной target равен
`http://127.0.0.1:3210`; порт самого Server задаётся независимо. Vite использует порт
5173 (либо `RELAY_WEB_PORT`) и `strictPort`: занятый порт не заменяется автоматически.
Настройка принадлежит [vite.config.ts](../vite.config.ts).

`bun run build` из `apps/web` создаёт production assets в `dist`. Node-wrapper
`scripts/vite.mjs` сохраняет Node runtime независимо от способа установки workspace.
Server получает готовые assets через свою сборку/`staticHandler`; Vite не нужен
пользователю поставляемого Web. Проверка исходного dev-server не подтверждает
встраивание ресурсов в бинарник.

## Источники инструкций

Загружайте установленные навыки через инструмент среды. Если загрузчик недоступен,
прочитайте их `SKILL.md` и нужные references на диске: типичное проектное размещение —
`.agents/skills/<имя>/`, но фактический каталог определяет среда агента. Наличие этого
каталога не предполагается для чистого checkout.

Для воспроизводимого чтения без установленного навыка используйте публичные снимки:

- [React Reference — SKILL.md][react-skill]. Обязательно также прочитайте
  [профиль React SPA][react-profile] и перед новым TSX — [инструкцию генерации][tsx-generation].
- [Unit Architecture — SKILL.md][unit-skill]; тематические главы открывайте по его карте.
- [REST API Codegen — SKILL.md][rest-skill] для работы с HTTP-клиентом. В Relay потребитель
  использует готовый `@relay/rest-sdk`, а реальные exports и генерация принадлежат пакету.

Ссылки закреплены по ревизиям публичных репозиториев. React Reference выбран в варианте,
согласованном с текущими шаблонами и `@gromlab/create@0.2.0`. Более новый внешний пример
не меняет автоматически package manager, генератор, тестовый runner или SDK этого checkout.
Версия исполняемого генератора имеет одного владельца — script `create` в manifest Web.
Установка и обновление dev-навыков выполняются отдельно по явному поручению; библиотеку
references не нужно копировать в репозиторий приложения.

Если установленные материалы отличаются по существенному правилу, сверяйте их с этим
профилем и закреплёнными источниками до изменения границы. Если обязательный источник
недоступен и локально, и публично, сообщите конкретный блокер вместо реализации по памяти.
Дополнительные skills выбираются по реальной задаче, а не по одному упоминанию в reference.

[react-skill]: https://github.com/gromlab-ru/js-reference/blob/8cabd89cebbcfa3d05a16c19d4f75bc3d300b1b5/skills/react-reference/SKILL.md
[react-profile]: https://github.com/gromlab-ru/js-reference/blob/8cabd89cebbcfa3d05a16c19d4f75bc3d300b1b5/skills/react-reference/reference/application/architecture/project-profile.md
[tsx-generation]: https://github.com/gromlab-ru/js-reference/blob/8cabd89cebbcfa3d05a16c19d4f75bc3d300b1b5/skills/react-reference/reference/application/components/tsx-generation.md
[unit-skill]: https://github.com/gromlab-ru/unit-architecture/blob/722e6066b27cdbea004729b8e295494e59294e7c/skills/unit-architecture/SKILL.md
[rest-skill]: https://github.com/gromlab-ru/rest-api-codegen/blob/18b73b1c1a7284ea1f1d98ae1703923620f43376/skills/rest-api-codegen-ru/SKILL.md

## Создание компонентов

Определите ответственность и владельца, прочитайте выбранный шаблон целиком и проверьте
отсутствие целевого каталога. Из `apps/web`, заменив имя и путь на выбранные:

```bash
bun run create ui-unit material-card src/compositions/widgets
bun run create ui-component details-panel src/compositions/screens/documents/ui
```

Первый шаблон создаёт самостоятельный юнит с фасетом, второй — внутренний компонент
владельца. Это альтернативные примеры размещения, а не обязательные части приложения.
Генератор создаёт собственный каталог компонента. Затем в том же изменении адаптируйте
назначение, props, типы и стили, удалите ненужные части и оставьте минимальный публичный API.
Форма шаблонов и команда из корня checkout описаны в [.templates/README.md](../.templates/README.md).

## Проверки изменения

После изменения кода, из корня checkout:

```bash
bun run --filter @relay/web lint
bun run --filter @relay/web typecheck
bun run --filter @relay/web build
```

Отдельно проверьте применимые правила skills, владельцев и свёрнутый граф зависимостей.
Oxlint, TypeScript и Vite не доказывают соблюдение всей Unit Architecture.

Автоматические проверки выбираются по [правилам тестирования](../../../docs/development/TESTING.md)
и размещаются по [организации наборов](../../../tests/README.md). У Web сейчас нет
собственных `test:*` scripts; это описание manifest, не запрет на новые тесты.
HTTP-сценарии SDK проверяются в наборе Server. При добавлении проверки сначала определите
её гарантию и владельца, затем подключите нужный уровень к принятому набору.
Пример Vitest из внешнего skill не является выбором runner для Relay.

## Браузерная приёмка

Проверяйте законченный пользовательский путь на реальном API и собственных fixtures
по правилам наборов. Совместная ручная проверка с человеком проводится в playground
по корневым инструкциям; автоматическая приёмка использует отдельные данные, порты
и процессы. Для поставки дополнительно откройте ресурсы из собранного Relay Server.

Используйте доступный в среде `agent-browser` и [headless-конфигурацию](../agent-browser.json).
Он не входит в runtime-зависимости Web; подготовка инструмента и браузера выполняется
отдельно по [официальной документации](https://agent-browser.dev/commands).
Перед использованием сверяйте команды с установленным `--help`.

Пример из корня checkout; `WEB_URL` должен указывать на собственный проверяемый сервер:

```bash
SESSION="relay-web-$(date +%s)-$$"
ARTIFACTS="$PWD/.artifacts/$(date +%F)/$SESSION"
mkdir -p "$ARTIFACTS"
agent-browser --help
agent-browser --session "$SESSION" --config apps/web/agent-browser.json open "$WEB_URL"
agent-browser --session "$SESSION" snapshot -i
agent-browser --session "$SESSION" a11y --json > "$ARTIFACTS/a11y.json"
agent-browser --session "$SESSION" console > "$ARTIFACTS/console.log"
agent-browser --session "$SESSION" errors > "$ARTIFACTS/errors.log"
agent-browser --session "$SESSION" screenshot "" "$ARTIFACTS/page.png"
agent-browser --session "$SESSION" close
```

В синтаксисе `screenshot [selector] [path]` пустой первый аргумент выбирает весь viewport,
второй — явный путь артефакта. Используйте уникальную сессию, не пользовательский профиль,
`--cdp`, `--auto-connect` или `close --all`. Headed-режим требует явного запроса человека.
После действий получайте свежие refs. Для SSE ожидайте наблюдаемое условие, а не
`networkidle`; не заменяйте синхронизацию произвольным sleep.

Матрица применимых проверок:

- обе темы, ширины **1440 / 1024 / 768 / 390**, длинный текст, переполнение и reduced motion;
- клавиатура и touch, начальный и возвращаемый фокус, Escape, диалоги и доступные имена;
- прямой URL, Back/Forward, reload, фильтры и возврат в исходный раздел;
- загрузка/пустое состояние/ошибка чтения и восстановления, сохранение реальной записи;
- конфликт исходной версии с сохранением draft; потеря ответа до и после commit,
  frozen operationKey и восстановление по receipt;
- внешнее изменение через CLI/другой клиент, SSE/reconnect без перезаписи ввода,
  поздние ответы и переход A → B → A;
- продолжение списка без дублей и смешения поколений, `PAGE_CHANGED`, фокус и прокрутка;
- для Git Sync — unknown и недоступность, очередь/конфликты/freshness, различие
  подключения SSE и подтверждённой доставки, наблюдение существующего requestId.

A11y-аудит и screenshots дополняют визуальную оценку, а типизация не заменяет browser
проверку. Сохраните фактические наблюдения и границы проверки в артефактах. Освободите
свою browser session, серверы и fixtures, включая завершение после ошибки.

## Изменение только документации

Сверьте описанные маршруты, команды и ограничения с текущими владельцами. Проверьте
локальные ссылки вместе с якорями и доступность добавленных внешних источников.
Из корня checkout:

```bash
bun x --no-install prettier --check apps/web/AGENTS.md apps/web/README.md apps/web/docs/*.md
git diff --check -- apps/web/AGENTS.md apps/web/README.md apps/web/docs
```

Документационная правка не требует перезапуска серверов или повторного browser-прогона.
Не превращайте документы в журнал проверок: результаты находятся в `.artifacts`,
а описание доступного поведения — у соответствующего владельца документа.
