# Relay Server

Server открывает локальный проект или workspace независимых SQLite-баз через REST API
и Web. Записи выполняет текущий Core, а обмен с Git запускается отдельным клиентом
Project Runtime. HTTP-приложение построено на NestJS 12 и Fastify 5 под Bun.

## Запуск

После [подготовки репозитория](../../README.md#быстрый-старт), из его корня:

```sh
bun run build:server
```

Сборка сначала получает готовый Vite dist под Node.js, затем упаковывает Server, guardian
и все Web-ресурсы в `apps/server/dist/relay-server`. Для запуска бинарника Bun, Node.js
и `node_modules` не нужны. Для Git-обмена нужен Git и совместимый `relay-git-sync`.

Из каталога уже инициализированного проекта или workspace:

```sh
/путь/к/relay-server --port 3210 --actor "Разработчик"
```

Server печатает JSON-сообщение `ready` с URL. `--port 0` выделяет свободный порт ОС.
Прямой запуск тоже регистрируется в Runtime; `relay server list/stop` видит этот экземпляр.
Пользовательские foreground/native-службы описаны в [руководстве CLI](../../docs/CLI.md#сервер-и-web).
`--help` и `--version` работают автономно, без проекта и чтения Web-файлов.

Выбор области: `--config`, `--home`, `--project`; значения среды `RELAY_CONFIG`,
`RELAY_HOME` применяются только на процессной границе. Автор выбирается из `--actor`,
`RELAY_ACTOR`, затем `web`. Неверное авторство отклоняется без нормализации.

Для Vite на `http://127.0.0.1:5173` разрешите origin явно:

```sh
relay-server --port 3210 --allow-origin http://127.0.0.1:5173
```

Альтернатива флагу — `RELAY_WEB_ORIGIN`. Vite proxy использует `changeOrigin:true`;
если открыт `localhost`, разрешённый origin должен точно совпадать с адресом браузера.

## Встраивание и жизненный цикл

```ts
import { startRelayServer } from "./src/server";

const server = await startRelayServer({
  runtime: { cwd: "/путь/к/проекту", home: "/путь/к/relay-home" },
  version: "0.0.0",
  actor: "Разработчик",
  port: 0,
});

console.log(server.url);
await server.close();
```

`createRelayServer(options)` возвращает Promise приложения без bind, пригодного для
`app.inject`. `startRelayServer` открывает loopback listener и возвращает фактические
`url`/`port`. `app` — настоящее `NestFastifyApplication`. Эти фабрики не регистрируют
процесс в Runtime: самостоятельный entrypoint владеет регистрацией и ОС-сигналами.

`close()` идемпотентен: запрещает новые handlers, завершает SSE, ожидает принятые
HTTP/Runtime операции и Core writers, закрывает проектные соединения и listener.
Разрыв клиента не отменяет начатый commit. Процессный bootstrap снимает readiness
перед drain и освобождает Runtime lease после закрытия ресурсов. У собственных процессных
запросов есть grace и общий shutdown deadline; зависший процесс не объявляется остановленным.

`staticHandler(request)` явно подключает Fetch `Response | null` для GET/HEAD вне `/api`.
Необязательный `controlHandler` получает исходный потоковый Request после guard; `null`
передаёт его обычному Nest handler. Защищённый процессный control Runtime работает
на собственном listener и не требует этого integration hook.
Процессный вход использует готовый embedded-каталог. Assets сохраняют MIME, точные байты,
Content-Length, ETag и HEAD/304; hash-файлы Vite кешируются immutable, HTML — с revalidation.
SPA fallback разрешён только HTML navigation на известный маршрут Web. Неизвестные API,
файлы и Worker-запросы остаются 404.

## HTTP-контракт

Префикс — `/api/v2`, спецификация — `GET /openapi.json`. Успех:
`{ok:true,data,meta?}`; отказ: `{ok:false,error:{code,message,details?}}`.
Переносимые DTO принадлежат Contracts, браузерный клиент — [REST SDK](../../packages/rest-sdk/README.md).
Обычные массивы, discriminated unions и отсутствие необязательных полей сохраняются.

- `/context` содержит режим, версию, автора и все регистрации, включая недоступные.
  Каталог фиксируется при bootstrap; изменение workspace требует перезапуска.
  Разные физические базы с одним ID отклоняются до bind. Перед запросом повторно
  проверяются ID и физическая идентичность файла; перепривязка не выбирает другой проект.
- `GET .../entity?ref=...&withVersions=true` возвращает карточку и исходные tokens одного
  Core anchor. `ref` — обязательный одиночный query-параметр, сохраняющий `.` и `..`.
  `GET .../entities?kind=document&limit=40` возвращает `items`, `total`,
  `generation`, `nextOffset` одного snapshot. Продолжение `offset>0` требует первоначальное
  поколение; `PAGE_CHANGED` означает новое чтение с начала. `root=true` для задач/сессий
  означает `parent:null`, `root=false` не фильтрует состав.
- `POST .../commands` принимает NamedCommand с обязательными `actor` и `operationKey`.
  `POST .../batch` — `{commands,actor,operationKey,expectedAddresses?,check?}`.
  Исходные `ifRevision`, `expectedVersion`, `expectedAddresses` и guards вложенных владельцев
  передаются Core без обновления. `check` откатывает изменения и не сохраняет receipt.
- `GET .../receipts?operationKey=...` читает первоначальную квитанцию. Ключ — обязательный
  одиночный query-параметр; даже `.` и `..` сохраняются дословно. Replay меняет только
  признак `replayed`, не читает заново текущие карточки и не повторяет mutation.
- Проекции знаний, документов, задач, планирования, истории, поиска и getMany перечислены
  в OpenAPI. В профильном path-маршруте ключи `.` и `..` передаются типизированной ссылкой
  Core, например `document:..` для связей документа; SDK выполняет это автоматически.
  Составные sync чтения используют snapshot; стоимость полных фильтрованных
  наборов остаётся у Core. Versioned read не оборачивается callback-транзакцией SQLite.
- `.../git-sync/status` получает cached Runtime status с `refresh:false` и проверяет
  используемый payload; пропавшее поле не превращается в `null` или ноль.
  `POST .../git-sync/now` принимает только `{}`: заранее назначает operationId, ждёт
  настоящий summary и отдельно читает outcome через `request.get`. Timeout сохраняет
  requestId; явное `GET .../git-sync/requests/:requestId` не запускает новый обмен.
- `.../events` — SSE `connected/changed/storage-error/heartbeat`. Общий watcher проекта
  читает только generation и замечает внешние commits CLI/Git Sync. Connected/reconnect
  требуют перечитать данные; поток не является журналом гарантированной доставки.

Host/Origin guard защищает весь HTTP, включая статику и preflight. JSON pipe принимает
только `application/json`, ограничивает тело 8 MiB до предметной записи, проверяет строгий
UTF-8 и сохраняет escaped UTF-16 code units. Streaming overflow возвращает JSON 413.

## Разработка

Исходный запуск и импорт Server должны использовать его конфигурацию legacy decorators:

```sh
# Из apps/server:
bun run dev -- --port 3210
# Для fixture, запускаемого из корня checkout:
bun --tsconfig-override apps/server/tsconfig.json path/to/fixture.ts
```

DI использует явные `@Inject` tokens; compiler `design:paramtypes` emit не требуется.
В standalone build обычный `external`-список исключает только неиспользуемые optional
расширения Nest (Express, microservices, WebSockets, view engines, class-transformer/validator).
Обязательные Nest/Fastify зависимости включаются в executable; `node_modules` не патчится.

```sh
# Из корня checkout:
bun run --filter @relay/server generate
bun run --filter @relay/server typecheck
bun run --filter @relay/server test:unit
bun run --filter @relay/server test:integration
bun x --no-install turbo run test:process --filter=@relay/server
```

Генератор связывает реальную Nest route metadata с переносимыми Contracts schemas;
согласованность контроллеров, wire-каталога и фактических Fastify routes проверяется отдельно.
Организация наборов и изоляция описаны в [руководстве тестов](../../tests/README.md).
