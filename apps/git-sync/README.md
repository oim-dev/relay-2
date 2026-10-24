# Relay Git Sync

Git Sync доставляет данные независимых локальных реплик Relay через обычный Git remote.
Все участники используют **одну общую ветку** `relay-data-v2`; другое имя можно выбрать
при подключении. Предметное объединение, проверка данных, конфликты и подтверждения
операций принадлежат [Core](../../packages/core/README.md).

Пользовательский вход — **`relay git-sync`**. Бинарник `relay-git-sync` является
согласованным по версии служебным компонентом CLI, worker и supervisor. Для обмена
нужен Git в `PATH` и настроенный доступ к remote. Кодовый checkout не обязателен:
URL и абсолютный путь bare-репозитория являются полноценными remote.

## Начать обмен

Пользовательские сценарии `connect`, первой публикации `now`, получения реплики через
`restore` и явного запуска supervisor описаны в одном месте —
[руководстве Git-синхронизации](../../docs/CLI.md#git-синхронизация).
Там различаются имя `origin` в кодовом checkout, URL remote, локальная SQLite
и служебный bare-репозиторий данных.

Корневая [сборка CLI](../../README.md#быстрый-старт) подготавливает и этот компонент.
Для отдельной разработки Git Sync из корня репозитория:

```bash
bun run build:git-sync
```

Локальные записи остаются durable в SQLite после выхода CLI, отказа сети или остановки
worker. `connect` проверяет remote без push и применения удалённого снимка; обмен
выполняет `now`. `restore` создаёт независимую БД, конфиг и подключение из опубликованной
ветки без предварительного `connect`. Существующая рабочая БД не заменяется.
Отдельный local resume после `RESTORE_RECOVERY_REQUIRED` сохраняет поздние записи
и не делает fetch/bootstrap/ack; его интерфейс описан в
[руководстве восстановления](../../docs/CLI.md#завершить-прерванную-локальную-публикацию).

`auto disable` сохраняет worker для локального capture, но прекращает новые фоновые
сетевые попытки. Уже начатый цикл завершается; `worker stop` отменяет его и сохраняет
desired `stopped`. `now` выполняет явную ограниченную попытку даже в manual-режиме.
Неразрешённые предметные конфликты после `now` дают `SYNC_CONFLICT`, exit 4; независимые
изменения при этом могут быть доставлены. `status` и чтение конфликтов остаются успешными.

`worker start`, `worker restart` и `auto enable` требуют уже готового supervisor.
Он запускается явно через `service enable` либо foreground `relay git-sync supervise`.
При его отсутствии возвращается `SUPERVISOR_REQUIRED`/`SUPERVISOR_NOT_RUNNING` без изменения
mode/desired. Persistent workers создаёт только supervisor под своим guardian и stdin lease.
Request-компонент отправляет `project.start` RPC и ждёт подтверждённый ready нового владельца;
его собственный strict process job может завершиться сразу после ответа.
`connect`, `restore`, cached `status` и one-shot `now` не требуют установки службы.

Явные `now`/`status --refresh` имеют отдельный `requestId`.
Пользователь читает его через `relay git-sync request get <id>`; в wire это
`request.get` с `input.requestId`. Доступны состояния
`queued`/`running`/`completed`/`failed`/`unknown`, без нового обмена.
`now` и refresh с `input.requestId` только ждут прежнюю операцию. Новый submit
использует `input.operationId`: Runtime назначает UUID до version probe/spawn,
либо сохраняет явный ID вызывающего wire-клиента. Два ID одновременно запрещены.
`waitMs` задаёт ожидание 1…90000 мс, по умолчанию 60000.
`GIT_SYNC_WAIT_TIMEOUT` обозначает истёкшее ожидание принятой операции с наблюдавшимся
queued/running, а не неготовность worker. Process timeout/cancel/повреждение envelope
сохраняют заранее назначенный ID с unknown, если исход нельзя подтвердить.
`GIT_SYNC_OUTCOME_UNKNOWN` не объявляет expiry успешным завершением или отменой.
Хранятся до 64 active и 128 recent outcomes с retention 15 минут; auto polling не журналируется.
One-shot принадлежит своему request lease: после завершения/аварии owner незавершённый исход
нужно запросить по ID, а не повторять пользовательскую мутацию.
Успешное чтение `request.get` не означает успешную операцию: требуется проверить `state`.
Исходы ожидания не заменяют durable outbox, transport ack и первоначальные batch receipts.

## Стык с CLI и Runtime

`relay-git-sync --version` печатает версию пакета без проекта и чтения stdin.
`relay-git-sync --request` принимает ровно один JSON из stdin до EOF и возвращает
ровно один JSON в stdout. Его exit code равен `error.exitCode`, при успехе — 0.
Wire-envelope ограничен 16 MiB, включая JSON/options; превышение даёт отказ без усечения.
Схемами оболочек владеет [Contracts](../../packages/contracts/README.md):

```json
{
  "version": 1,
  "action": "status",
  "options": { "cwd": "/путь/к/проекту", "home": "/путь/к/relay-home" },
  "input": { "refresh": false }
}
```

Ответ: `{ "version": 1, "ok": true, "data": ... }` либо
`{ "version": 1, "ok": false, "error": { "code", "message", "exitCode", "details"? } }`.
Тексты ошибок русские; программная обработка использует стабильный `code`.

| Действие                                                                       | `input`                                                                                                       |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `connect`                                                                      | `remote`, необязательный `branch`                                                                             |
| `restore`                                                                      | `remote?`, `branch?`; либо `resume: true`, `projectId?` без нового remote                                     |
| `status`, локальное чтение                                                     | `refresh` отсутствует либо `false`                                                                            |
| `status`, обновление remote                                                    | `refresh: true`, `operationId?` для submit либо `requestId` для ожидания, `waitMs?`                           |
| `now`                                                                          | `operationId?` для submit либо `requestId` для ожидания, `waitMs?`                                            |
| `request.get`                                                                  | `requestId`; только чтение исхода                                                                             |
| `auto.enable`, `auto.disable`, `worker.start`, `worker.stop`, `worker.restart` | пустой объект                                                                                                 |
| `conflicts.list`                                                               | пустой объект                                                                                                 |
| `conflicts.get`                                                                | `id`                                                                                                          |
| `conflicts.resolve`                                                            | `id`, `decision` с `fingerprint` и `choice: "local" \| "remote" \| "custom"`, `actor`; custom требует `patch` |
| `supervisor.status`, `supervisor.stop`                                         | пустой объект; достаточно `options.cwd/home`, проект не открывается                                           |

Custom v1 использует `decision: {fingerprint, choice:"custom", patch:[{transition, entityId,
field, value}]}`. `field` — только `body`, `name`, `summary`; `transition` — индекс исходной
command boundary. Core допускает только существующий document text effect первоначального
changeset: выбранное поле должно действительно меняться в этой boundary.
Legacy atomic source использует индекс 0. Core проверяет fingerprint, область поправки
и весь ordered tape; остальной batch проходит обычное согласование. Original source,
его digest и первоначальная receipt не изменяются. Пример решения — в
[руководстве конфликтов](../../docs/CLI.md#просмотреть-и-разрешить-конфликт).
`conflicts.list` возвращает `{conflicts, blocked}` с двумя обязательными массивами.
Conflicts содержит `{id, fingerprint, code, message}`, blocked —
`{id, state:"pending", code:"REPLICATION_DEPENDENCY", message, dependencies}`.
Get по реальному конфликту возвращает полные сохранённые стороны; по blocked ID —
причину ожидания без fingerprint/сторон. Неизвестный ID
даёт `GIT_SYNC_CONFLICT_NOT_FOUND`, exit 3. Resolve blocked ID даёт
`REPLICATION_DEPENDENCY`, exit 4, с `details.blocked`, без изменения данных или решения.
Результат actual resolve — `{id, generation, included, conflicts, blocked, pending,
deferred, hasMore}`: diagnostics полные, а included/deferred/hasMore относятся к bounded
preview. Эта полная диагностика не выполняется в hot status/prepare.

Справка, представление и `status --all` принадлежат основной CLI/Runtime. Прямые импорты
другого приложения не нужны. Для пользовательской службы Runtime запускает:

```bash
relay-git-sync supervise --home /абсолютный/relay-home
```

Foreground-прокси основной CLI добавляет приватный `--parent-lease` и держит stdin pipe
открытым. EOF после завершения или SIGKILL прокси вызывает graceful shutdown supervisor
и его workers. Прямой запуск native-службы не использует lease; постоянные workers
переживают обычное завершение коротких CLI-команд.

Перед native disable/restart Runtime может вызвать `supervisor.stop`: это graceful
остановка всех зарегистрированных workers с ожиданием освобождения ресурсов. Desired
состояния проектов сохраняются. Установка systemd, launchd и Windows Task Scheduler
принадлежит Runtime, а не этому приложению.

Внутренний worker-entrypoint запускается supervisor с контекстом проекта/БД и его lease.
Пользователь управляет worker через `relay git-sync worker`, не создавая самостоятельный
постоянный процесс из короткого request. Supervisor читает явный локальный реестр
`<home>/git-sync/registry.json`, без обхода workspace aliases.

## Владение, обмен и диагностика

Служебное состояние находится рядом с **физическим путём SQLite** в
`<databasePath>.git-sync/`. Там лежат подключение, private bare `repository/`, локальные
capture/prepared checkpoints и диагностический cache. Они не публикуются в remote.
Готовность worker хранится в `worker.json`, supervisor — в `<home>/git-sync/supervisor.json`.
Endpoint-файл содержит случайную capability и имеет права 0600; localhost HTTP проверяет
версию, идентичность и nonce конкретного запуска. Lifetime mutex Storage исключает двух
владельцев и освобождается ОС после crash; PID не является доказательством готовности.

Supervisor обслуживает все running проекты и перезапускает crash с индивидуальным
backoff. FIFO-очередь ограничивает число одновременно активных сетевых циклов четырьмя;
queued/granted места принадлежат живому `network.lease` HTTP stream. EOF клиента удаляет
его место, EOF supervisor отменяет Git клиента. Endpoint-файл не является lifetime permit.
Постоянные workers не занимают слот в простое. Polling продолжается при пустом outbox.
Один цикл делает fetch только общей ветки без tags, готовит кандидат на полученном
remote head и выполняет обычный FF push. Один `run()`/`now` завершает одно bounded окно
Core: до 64 sources / 8 MiB исходного JSON, с неделимым oversized исключением.
Конкурентное продвижение вызывает конечный retry того же исходного cursor с jitter.
Потерянный push-ответ проверяется по принятой истории, без повторения
пользовательской мутации. Git-процессы имеют отдельного guardian с lease от владельца,
ограничением потоков, deadline и очисткой дерева после смерти владельца.
Linux использует группу и subreaper, Windows — Job Object. На macOS используется
POSIX-группа: потомок, самостоятельно выполнивший `setsid`, выходит за текущую гарантию.
Каждый Git-вызов задаёт `gc.autoDetach=false` и `maintenance.autoDetach=false` без изменения
global config. Для default OpenSSH профиль определяется в точном Git окружении через `-V`
и безопасный `-G -F <null>` probe. Реальное соединение получает проверенный
`ControlPersist=no` и, если клиент его поддерживает, `ForkAfterAuthentication=no`.
В реальном соединении `-F` не добавляется: identity, proxy, Keychain и обычный SSH config
сохраняются. Существующие внешние ssh-agent/master не относятся к нашим потомкам.

`GIT_SSH_COMMAND`, `GIT_SSH`, `GIT_SSH_VARIANT`, `core.sshCommand` и `ssh.variant`
сохраняются дословно. Они отмечаются как custom в `status.transport.ssh`; их произвольное
самостоятельное daemonize/setsid на macOS не объявляется полностью контейнированным.
Неизвестному или слишком старому клиенту неподдержанные опции не навязываются.
Worker наследует окружение supervisor и актуальные Git/SSH config; изменение окружения
сервиса применяется после перезапуска supervisor, без передачи credentials в IPC request.

Writer выпускает **`layoutVersion: 2`, `formatVersion: 1`, `modelVersion: 2`**
в закрытом `manifest.json` вместе с `projectId`; reader поддерживает явные ветки layout 1 и 2.
Текущие raw owners без локального CAS находятся
в `entities/<hash>/record.json`, scoped primary parts — в `components/<hash>/record.json`,
комментарии — в `comments/<hash>/record.json`, receipts — в `receipts/<hash>.json`.
`addresses.json` и `confirmations.json` содержат канонические наборы по ref/replicaId;
`publication.json` — только последнюю публикацию с source/effective tape, решениями и proofs.
Ранние публикации остаются в Git history, а не копируются вечным payload log в текущее дерево.
Новые JSON-файлы имеют рекурсивный lex UTF-16 порядок ключей, двухпробельный отступ
и один завершающий LF, включая корректный порядок numeric-like ключей. Значимые
массивы и строки не нормализуются. Core fingerprints остаются SHA-256 компактного
канонического JSON UTF-8 без LF; файловое оформление не меняет предметные версии
и immutable source IDs/digests.

`<hash>` — lowercase SHA-256 **UTF-8 без Unicode-нормализации** постоянного entity/comment ID
либо operationKey. Для component хешируется UTF-8 `JSON.stringify([ownerId, kind, id])`.
Некорректные UTF-16 identity/address/SQL-author значения отвергает общая граница Contracts/Core.
Полная история проверяется через непосредственные Git parents и pure Core replay; capture с
`publication: null` сам по себе не считается удалённой публикацией. Markdown
сохраняется точными raw blobs: CRLF, tabs, конечный newline не зависят от autocrlf,
attributes или фильтров checkout. Непарные UTF-16 surrogate остаются в JSON escape,
чтобы UTF-8 не заменял их молча. Имена файлов — короткие отпечатки постоянных ID;
symlink, executable, submodule, неизвестные пути и неверная форма отвергаются.

Layout 2 использует wrappers `{entity, markdown}`, `{component, markdown}` и
`{comment: PortableComment, markdown}`. PortableComment внутри сохраняет
`{taskId, after, comment: {...}}`. Обязательный `markdown` — массив закрытых
`{field, digest}`, где digest — lowercase SHA-256 точных байтов соседнего `<field>.md`.
У entity/component выносятся body/description/summary, у comment — body.
Пустой well-formed текст тоже выносится; lone-surrogate строка остаётся inline JSON
без дескриптора. Дубли, inline/blob одновременно, неверные bytes/digest и duplicate
JSON keys отвергаются. Layout 1 читается по прежним wrappers с прежними Core-проверками;
idle не переписывает его коммиты, новые предметные публикации используют layout 2.
Точный физический контракт — в [разделе snapshot ТЗ](../../GIT-SYNC-IMPLEMENTATION-SPEC.md#7-переносимый-snapshot-и-git-формат).

Проверяемая публикация связывает точного родителя, source digests, effective ordered
transitions, immutable решения и итоговый snapshot. Непосредственного Git parent
проверяет транспорт, предметные переходы — Core. API
`validateReplicationHistory(base, target, {chain})` возвращает
`ValidatedReplicationHistory` с транзитивно неизменяемым `proof.snapshot`.
`prepare(proof.snapshot, proof)` и `accept(proof.snapshot, proof)` переиспользуют
только Core-issued capability для этой точной цели и фактической принятой основы.
JSON-копия, самостоятельный constructor или непроверенный prefix такой authority
не дают. Это in-process свидетельство проверки, не Git ack; локальные guards,
source proofs и pending overlay проверяются при применении заново.

Обычный `status` читает SQLite, локальный cache и проверяет IPC; **Git subprocess и сеть
remote не запускаются**. `refresh: true` выполняет fetch/validation и обновляет известный
remote без push или применения его данных. Существенные поля результата:

- `worker`: desired/actual, responsive, версия, instance, PID, started/heartbeat;
- `mode`, `phase`, `attemptId`: текущая работа живого владельца;
- `git`: проверенные `localHead`, `remoteHead`, реальные `ahead`/`behind` между ними;
- `pending`: durable changesets, oldest/age, отдельно `unexported`;
- `publication`: сохранённый `afterSequence` и последнее bounded `window` либо null;
- `lastFetch`, `lastSuccess`, `lastAttempt`, `freshness`, `conflicts`, структурированный `error`;
- `nextRetry`/`nextAttempt`: только фактически назначенный повтор живого планировщика.

Неизвестные счётчики — `null`. Пустая Git-разница не обещает пустой outbox или доступность
сети. Изменения, сделанные после подготовки Git-кандидата, остаются pending; при
невозможности точно вывести число непроэкспортированных пакетов оно также `null`.

Cursor в `progress.json` привязан к replicaId и физическому пути БД; старый файл без
cursor начинает с 0, смена области сбрасывает прежнюю наблюдаемость. Он продвигается
после установленного accept либо окна с included=[] без фиктивного ACK; unknown push
сохраняет прежний cursor. `window` содержит afterSequence/nextSequence, hasMore,
examined/included/deferred, sourceBytes, oversized и completed. Последние deferred/hasMore
относятся к подготовке окна; `pending.changesets` — актуальный полный остаток после accept.
Completed и конец обхода не означают пустой outbox. Частичный prepare показывает
`conflicts.freshness: "partial"`, не current по одному совпадению generation.
После успешного auto-окна с hasMore назначается продолжение через 500 мс, на конце
обхода — обычный polling 5 с. `nextAttempt.reason` различает publication-window/polling
и причины retry; эти интервалы не являются SLA доставки.

Подробные инварианты и критерии приёмки: [дизайн](../../GIT-SYNC-DESIGN.md),
[спецификация](../../GIT-SYNC-IMPLEMENTATION-SPEC.md). Проверки компонента размещены
по [правилам наборов](../../tests/README.md); process-набор использует собственный
собранный `dist/relay-git-sync` и изолированные fixtures.

### Исходный запуск и helper-процессы

Source entry использует `withGitProcessRuntime`: один свежий минимальный Runtime helper
с bytecode на lifetime сценария. Он собирается лениво перед первой внешней командой текущим Bun
из текущих исходников; cached status без процессов сборку не запускает.
старый `dist` не служит заменой source-проверкам. Scope ожидает начатые guarded commands
перед удалением helper. При прямом библиотечном вызове вне scope доступен raw source entry
Runtime. Standalone сборка приложения также содержит bytecode и обслуживает свою private роль.

Для source entry временный helper находится в `.artifacts/<дата>/git-sync-source-runtime`
этого checkout; при source Git-обмене checkout должен быть доступен для записи артефактов. Fixtures
используют ту же композицию с собственным каталогом и сохраняют независимые SQLite/Git/HOME.
На отказ конечного team-сценария публикуется bounded phase/Git-cost summary в подкаталог
`CI_LOG_DIR/git-sync-team`, а без CI — в артефакты fixture. Wrapper durations и native
Git trace2 `t_abs` отражаются отдельно; отчёт не задаёт порогов производительности.
