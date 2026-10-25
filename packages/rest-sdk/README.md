# REST SDK

`@relay/rest-sdk` — браузерный Fetch-клиент текущего Relay Server. Он нужен Web и другим
HTTP-потребителям для работы с точными DTO, исходными версиями и предметными ошибками.
Операции, HTTP-клиент и wire-типы генерируются из OpenAPI реального Server.
Публичный `createRelayClient` сохраняет переносимые DTO из Contracts.
Пакет не зависит от Bun, SQLite, Core или локального контекста проекта.

```ts
import { createRelayClient, RelayApiError } from "@relay/rest-sdk";

const relay = createRelayClient(); // текущий origin; можно передать {baseUrl:"http://127.0.0.1:3210"}
const { data: context } = await relay.context();
const projectId = context.projects.find((project) => project.available)?.id;
if (projectId) {
  const { data: page } = await relay.entities(projectId, { kind: "document", limit: 40 });
  const document = page.items[0];
  if (document?.kind === "document") {
    const read = await relay.entity(projectId, document.id, { withVersions: true });
    try {
      await relay.command(projectId, {
        op: "document.update",
        ref: document.id,
        ifRevision: read.data.revision,
        input: { body: "Новое содержание" },
        actor: context.actor,
        operationKey: crypto.randomUUID(),
      });
    } catch (error) {
      if (error instanceof RelayApiError) {
        console.error(error.code, error.message);
      } else {
        throw error;
      }
    }
  }
}
```

Методы возвращают `{ok:true,data,meta?}`; metadata доступна рядом с данными, включая
`meta.versions[id].aggregateVersion`. `RelayApiError` сохраняет `code`, `status` и
`details`; неверный JSON также сохраняет исходную причину в `cause`.
`entity(projectId, ref)` передаёт исходный адрес через query; `read` сохраняет dot-ключи
`.` и `..` через типизированную ссылку владельца, без предварительного разрешения ID.
Клиент не обновляет CAS, не подставляет автора и не повторяет mutations
автоматически. После потерянного ответа можно прочитать `receipt(projectId,operationKey)`.
Ключ передаётся query-параметром без изменения: допустимые `.` и `..` также адресуют
сохранённую квитанцию. Точная форма маршрута — в [HTTP-контракте Server](../../apps/server/README.md#http-контракт).

Кроме `context`, `entity`, `entities`, `command`, `batch`, `receipt`, `overview` и
`gitSyncNow` доступен точный именованный reader. После выбора `projectId` и `taskId`:

```ts
const { data: progress } = await relay.read(projectId, "taskProgress", { ref: taskId });
const stop = relay.subscribe(projectId, (event) => {
  // connected, включая reconnect, и changed требуют перечитать используемые данные.
  console.log(event.type, event.generation);
});
stop();
```

Имена и параметры проекций находятся в `HttpReadResults`/`HttpReadParameters` Contracts;
тип `kind` по-прежнему определяет точный `data` карточки. `eventsUrl(projectId)` доступен
для собственного EventSource. SDK использует native Fetch и EventSource; для теста HTTP
можно передать явный `fetch` фабрике.

## Генерация и разработка

После [установки зависимостей](../../README.md#быстрый-старт) из корня checkout:

```sh
bun run --filter @relay/rest-sdk generate
bun run --filter @relay/rest-sdk generate:check
bun run --filter @relay/rest-sdk typecheck
bun run --filter @relay/rest-sdk test:unit
```

`generate` сначала обновляет спецификацию Server, затем запускает публичный CLI
`@gromlab/rest-api-codegen@5.2.4` под Node.js 24+ через `bun x` без `--bun`.
`generate:client` использует уже подготовленный `apps/server/openapi.json`.
`generate:check` сравнивает весь output с новой генерацией, включая лишние файлы,
и не перезаписывает исходники. Временный output размещается в `.artifacts`.

Каталог `src/generated/` целиком принадлежит CLI: ручные правки и overrides в нём
не сохраняются. Facade и адаптация HTTP envelope находятся вне него; пути, методы,
сериализация и выполнение Fetch принадлежат generated operations/HttpClient.
Публичной точкой входа пакета остаётся только `@relay/rest-sdk`.

Сборка `bun run --filter @relay/rest-sdk build` выпускает vendor JS и декларации в
`dist/generated/`. Она нужна до прямого запуска consumers из чистого checkout.
SDK `generate`, `typecheck` и `test:unit` выполняют её автоматически.
Версия генератора 5.2.4 требует отдельного `tsconfig.generated.json`: только vendor source
проверяется без `exactOptionalPropertyTypes` и `noUnusedParameters`. Handwritten browser SDK
проверяется со всеми строгими настройками проекта и импортирует compiled declarations.
В runtime генератор, Bun и Node.js не подключаются.

Модульный набор SDK проверяет ошибки envelope, JSON/cause, URL/query, metadata,
исходные guards и отсутствие retry. Предметные HTTP-сценарии проверяются
[интеграционным набором Server](../../apps/server/README.md#генерация-и-проверки).
