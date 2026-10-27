# Разработка Web

Web использует React, Mantine, React Router, SWR, CodeMirror, dnd-kit и React Flow/ELK.
Исходные визуальные компоненты первой версии перенесены вместе с CSS Modules.
Доменные адаптеры используют текущие Contracts и общий REST SDK.

## Запуск

Установите workspace через `bun install --frozen-lockfile`. Для Vite нужен Node.js 24+.
Из корня репозитория при работающем Server на собственных данных:

```sh
RELAY_API_URL=http://127.0.0.1:3210 bun run dev:web
```

Web слушает `127.0.0.1:5174`; Server должен явно разрешать этот origin. Для другой пары
портов задайте `RELAY_API_URL` и `RELAY_WEB_PORT`. Занятый порт вызывает ошибку.
Production assets создаёт `bun run build:web`; `bun run build:server`
включает их в самостоятельный бинарник.

## Источники инструкций

Применяются корневые правила Relay, [React Reference][react], [профиль React SPA][spa]
и [Unit Architecture][units]. Актуальный transport имеет источники у
[Server](../../server/README.md) и [REST SDK](../../../packages/rest-sdk/README.md).

Перенесённый TSX изменяется как существующий код. Для нового прикладного TSX применяется
[инструкция генерации][generation] и локальные [шаблоны](../.templates/README.md).
Команда из `apps/web`:

```sh
bun run create ui-component details-panel src/compositions/screens/<владелец>/ui
```

Необходимо сначала прочитать выбранный шаблон и проверить отсутствие целевого каталога.

[react]: https://github.com/gromlab-ru/js-reference/blob/8cabd89cebbcfa3d05a16c19d4f75bc3d300b1b5/skills/react-reference/SKILL.md
[spa]: https://github.com/gromlab-ru/js-reference/blob/8cabd89cebbcfa3d05a16c19d4f75bc3d300b1b5/skills/react-reference/reference/application/architecture/project-profile.md
[generation]: https://github.com/gromlab-ru/js-reference/blob/8cabd89cebbcfa3d05a16c19d4f75bc3d300b1b5/skills/react-reference/reference/application/components/tsx-generation.md
[units]: https://github.com/gromlab-ru/unit-architecture/blob/722e6066b27cdbea004729b8e295494e59294e7c/skills/unit-architecture/SKILL.md

## Проверки изменения

Из корня репозитория:

```sh
bun run --filter @relay/web lint
bun run --filter @relay/web typecheck
bun run --filter @relay/web test:unit
bun run build:web
```

Тесты выбираются по [правилам наборов](../../../tests/README.md).

## Браузерная приёмка

Сборка и типизация не проверяют экранный UX. Проверяйте в собственном headless `agent-browser` и на
изолированных данных: обе темы, 1440/1024/768/390, keyboard/touch, Escape и фокус,
длинные тексты, прямые ссылки, Back/Forward, сохранение форм, конфликт, receipt,
SSE/reconnect, A → B → A и продолжение списков.

Визуальные изменения сравниваются с исходными экранами легаси. Для поставки проверяются
assets из собранного Server. Совместная ручная приёмка с человеком проходит в playground.
Артефакты и журналы размещаются только в `.artifacts/YYYY-MM-DD/<имя>` от корня checkout;
собственные процессы и browser session закрываются после проверки.
