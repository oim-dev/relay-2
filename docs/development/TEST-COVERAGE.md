# Карта проверяемых сценариев

Карта связывает поведение с существующими тестами. «Проверяется» означает наличие
смысловых утверждений в указанном наборе, а не обещание полного покрытия всех
комбинаций или успешного последнего запуска. Результаты запусков принадлежат
`.artifacts/`; правила оценки теста — в [TESTING.md](TESTING.md).

## Общие переносимые правила

| Гарантия                                                                                                                                                    | Где проверяется                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Автор сохраняется дословно; неверное значение даёт RelayError с кодом, exitCode и полем actor. Каноническое имя проекта и slug проверяются без нормализации | [Идентичность: unit](../../packages/contracts/src/entities/identity.unit.test.ts) |

[Контракт группового чтения](../../packages/contracts/src/queries/entity-read.unit.test.ts)
проверяет границы количества адресов и точную форму параметров полного/краткого представления.

## Хранение и локальные проекты

| Гарантия                                                                                                                            | Где проверяется                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Создание базы со схемой и WAL; отказ перезаписи существующего файла, открытия отсутствующей/чужой базы и неподдерживаемой схемы     | [Storage: база](../../packages/storage/tests/integration/database.integration.test.ts)                                                                                                                                                                                                        |
| Конкурентное DELETE→WAL открытие сохраняет идентичность и outbox; занятый reader даёт ограниченный отказ, readonly не меняет журнал | [Storage: открытие соединений](../../packages/storage/tests/integration/concurrent-open.integration.test.ts)                                                                                                                                                                                  |
| Rollback возвращает записи, алиасы, счётчики и поколение; вложенный savepoint откатывается независимо                               | [Storage: транзакции](../../packages/storage/tests/integration/transactions.integration.test.ts)                                                                                                                                                                                              |
| CAS сохраняет победившую запись; конфликт и no-op используют исходную ревизию; неизменяемые поля защищены                           | [Storage: база](../../packages/storage/tests/integration/database.integration.test.ts), [конкурентные писатели](../../packages/storage/tests/integration/concurrent-writers.integration.test.ts)                                                                                              |
| Чтение committed-состояния при активном писателе; список и поколение в одном снимке; отказ повышения устаревшего снимка до записи   | [Storage: транзакции](../../packages/storage/tests/integration/transactions.integration.test.ts)                                                                                                                                                                                              |
| Транзакционный callback синхронен; async/Promise отклоняются                                                                        | [Storage: транзакции](../../packages/storage/tests/integration/transactions.integration.test.ts), [локальный mutex](../../packages/storage/tests/integration/local-lock.integration.test.ts)                                                                                                  |
| Комментарии append-only, переживают CAS содержания и повторное открытие; FK и тип цели проверяются                                  | [Storage: комментарии](../../packages/storage/tests/integration/task-comments.integration.test.ts)                                                                                                                                                                                            |
| Окно списка декодирует только выбранные записи; total и состав относятся к одному снимку, сортировка и offset определяют окно       | [Storage: страницы](../../packages/storage/tests/integration/pages.integration.test.ts)                                                                                                                                                                                                       |
| Проекция графа исключает тексты задач/критериев и независимый журнал комментариев; адреса возвращают только id/kind/key             | [Storage: страницы](../../packages/storage/tests/integration/pages.integration.test.ts)                                                                                                                                                                                                       |
| Два процесса сериализуют изменение JSON; занятость даёт WORKSPACE_BUSY; SIGKILL освобождает mutex без замены lock-файла             | [Storage: локальный mutex](../../packages/storage/tests/integration/local-lock.integration.test.ts)                                                                                                                                                                                           |
| Независимые базы; relay.config.json ищется только в cwd; явный config, относительные пути и symlink; потерянная база не создаётся   | [Project Runtime](../../packages/project-runtime/tests/integration/runtime.integration.test.ts)                                                                                                                                                                                               |
| Имя и slug проверяются; конкурентный init публикует один проект; повреждённый конфиг в cwd не игнорируется                          | [Имена проектов](../../packages/project-runtime/tests/integration/project-naming.integration.test.ts), [гонки](../../packages/project-runtime/tests/integration/concurrency.integration.test.ts), [конфигурация](../../packages/project-runtime/tests/integration/config.integration.test.ts) |
| Workspace выбирает проект, сохраняет данные при удалении регистрации; конкурентные регистрации не теряются, JSON читается целиком   | [Workspace](../../packages/project-runtime/tests/integration/workspace.integration.test.ts), [гонки](../../packages/project-runtime/tests/integration/concurrency.integration.test.ts)                                                                                                        |

Отдельные проверки [публикации workspace](../../packages/project-runtime/tests/integration/workspace.integration.test.ts)
подтверждают целый прежний JSON до атомарной замены и сохранность реестра при отказе публикации.
Регистрации хранят пути каталогов с обязательным `relay.config.json`; выбор из вложенного
каталога не использует родительский workspace. [Проверки конфигурации](../../packages/project-runtime/tests/integration/config.integration.test.ts)
защищают разрешение относительных каталогов через symlink workspace и чтение актуальных
ID и пути базы из конфига выбранного проекта.

Для конфига без `databasePath` [Runtime](../../packages/project-runtime/tests/integration/runtime.integration.test.ts)
проверяет стандартное размещение через `home`, относительный корень, перенос home,
отказ без создания отсутствующей базы и приоритет явного пути. Новый init сохраняет
только `version` и `projectId`. [Workspace](../../packages/project-runtime/tests/integration/workspace.integration.test.ts)
проверяет передачу относительного home при регистрации и выборе такого проекта;
[конфигурация](../../packages/project-runtime/tests/integration/config.integration.test.ts)
отвергает неверный явный путь и ID, который не может служить отдельным именем каталога.

[Выборки Storage](../../packages/storage/tests/integration/selections.integration.test.ts)
проверяют пакетное чтение по постоянным ID: порядок, повторы, пропуски и ожидаемый вид,
лёгкие идентичности без JSON/журналов и точный отбор строкового поля внутри SQLite.
[Журнал задач](../../packages/storage/tests/integration/task-comments.integration.test.ts)
защищает CAS содержания без десериализации прежней карточки и сохранность комментариев.
[Адресные проекции](../../packages/storage/tests/integration/entity-reads.integration.test.ts)
проверяют ключи, ID и алиасы с явными пропусками, порядок и повторы; SQL краткого чтения
выбирает только идентичность, ревизию, название и состояние, без тел и журналов.
[Квитанции](../../packages/storage/tests/integration/batch-receipts.integration.test.ts)
защищают уникальность ключа, неизменяемость результата и общий rollback с сущностями.
[Историческая схема v1](../../packages/storage/tests/integration/batch-receipt-upgrade.integration.test.ts)
проверяет техническую миграцию без потери данных, откат частично выполненного DDL,
сохранность несовместимого файла и rollback данных/квитанции при отказе INSERT либо COMMIT.
[Workspace](../../packages/project-runtime/tests/integration/workspace.integration.test.ts)
проверяет однократное чтение/декодирование реестра через symlink и доступность list/remove
при утраченной базе зарегистрированного проекта.

[Нормализованные части](../../packages/storage/tests/integration/components.integration.test.ts)
проверяют собственные scoped ID и версии критериев, этапов и включений; owner не хранит
вторую копию коллекции. Правка части сохраняет соседние версии и позиции, снятие/повторное
включение создаёт новый ID с tombstone прежнего. Sparse import меняет только затронутого
владельца, restore сохраняет точные части без echo, readonly не исправляет повреждение.
[Миграции частей](../../packages/storage/tests/integration/components-migrations.integration.test.ts)
сверяют карточки, scoped ID, алиасы, комментарии, квитанции и исходный outbox после
перехода схем v2/v3 к v4 и повторного открытия.
[Durable outbox](../../packages/storage/tests/integration/replication.integration.test.ts)
защищает общий rollback записи и changeset, savepoint, receipt-only изменения и сохранение
исходных bytes/digest исторических пакетов при миграции.

## Предметные сценарии Core

| Гарантия                                                                                                                                               | Где проверяется                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JSON/автор/ревизия проверяются; no-op сохраняет метаданные; общий resolver типизированных ссылок/алиасов и get работают в одном снимке                 | [Сущности](../../packages/core/tests/integration/entities.integration.test.ts), [задачи](../../packages/core/tests/integration/tasks.integration.test.ts)                        |
| Декодер знаний сохраняет пустой паспорт, отсутствие разделов, полные тексты и связи; повреждённые поля отвергаются чтением и записью                   | [Декодер знаний: unit](../../packages/core/src/knowledge/knowledge-data.unit.test.ts), [знания: интеграция](../../packages/core/tests/integration/knowledge.integration.test.ts) |
| Порча runs/checkpoints — отказ чтения/записи без изменений; неверное имя цели блокирует снимок; null, пустой паспорт и пустой title задачи допустимы   | [Декодеры истории: unit](../../packages/core/src/history/history-data.unit.test.ts), [история: интеграция](../../packages/core/tests/integration/history.integration.test.ts)    |
| Изменение проекта согласовано с правилами имени/slug; приложение владеет доской, её имя меняется атомарно                                              | [Знания](../../packages/core/tests/integration/knowledge.integration.test.ts)                                                                                                    |
| Конфликт создания доски откатывает приложение и счётчик; ключ не перехватывает чужой slug/prefix                                                       | [Знания](../../packages/core/tests/integration/knowledge.integration.test.ts)                                                                                                    |
| Реализация сценария требует реализации фичи своего приложения; замена участия целиком проверяется, снятие/возврат сохраняют адреса и тексты            | [Знания](../../packages/core/tests/integration/knowledge.integration.test.ts)                                                                                                    |
| Порядок разделов, удаление без переписи документов, запрет повторного ID; отношения документа различают цель и тип                                     | [Знания](../../packages/core/tests/integration/knowledge.integration.test.ts)                                                                                                    |
| Циклы зависимостей, родительства и смешанные циклы запрещены; невыполненные обязательства блокируют завершение                                         | [Задачи](../../packages/core/tests/integration/tasks.integration.test.ts)                                                                                                        |
| Чистый граф учитывает смешанные обязательства без дублей блокеров, отвергает циклы и пропавшие цели; декодер проверяет минимальную проекцию            | [Граф задач: unit](../../packages/core/src/tasks/task-graph.unit.test.ts)                                                                                                        |
| Повторное открытие зависимости транзитивно меняет вычисляемое выполнение; готовность отличается от сохранённой колонки                                 | [Задачи](../../packages/core/tests/integration/tasks.integration.test.ts)                                                                                                        |
| Изменение критерия сбрасывает отметку; done ограничивает операции с критериями; комментарии не заменяются старым снимком содержания                    | [Задачи](../../packages/core/tests/integration/tasks.integration.test.ts)                                                                                                        |
| Цели ограничены доской/приложением; снятые реализации не получают новые назначения; перенос доски сохраняет ID, алиасы и связи                         | [Задачи](../../packages/core/tests/integration/tasks.integration.test.ts)                                                                                                        |
| Новое обязательство между load и commit отклоняет done по graph predicate; независимый append сохраняется без подстановки свежего CAS                  | [Транзакция задачи](../../packages/core/tests/integration/task-transaction.integration.test.ts)                                                                                  |
| Задача имеет одно текущее включение в открытый план/этап; перенос проверяет обе ревизии и откатывается при отказе второй записи                        | [Планирование](../../packages/core/tests/integration/planning.integration.test.ts)                                                                                               |
| Начало плана требует цели и состава; завершение зависит от фактических обязательств; закрытый план ограничивает изменения                              | [Планирование](../../packages/core/tests/integration/planning.integration.test.ts)                                                                                               |
| Выпуск требует завершённых планов с актуально выполненными задачами; released неизменяем, отменённый релиз перепланируется явно                        | [Планирование](../../packages/core/tests/integration/planning.integration.test.ts)                                                                                               |
| progress плана/релиза, complete и publish: один граф на весь состав, включая несколько планов; без декодирования тел и комментариев задач              | [Планирование](../../packages/core/tests/integration/planning.integration.test.ts)                                                                                               |
| Базовые страницы планов/релизов не читают полный список; фильтр плана применяется до окна; состав этапа и задачи читаются согласованно                 | [Планирование](../../packages/core/tests/integration/planning.integration.test.ts)                                                                                               |
| Страницы документов/задач: total, единый Unicode-порядок с непарными суррогатами, пустое окно; раздел документа и страница — один снимок               | [Знания](../../packages/core/tests/integration/knowledge.integration.test.ts), [задачи](../../packages/core/tests/integration/tasks.integration.test.ts)                         |
| CAS сессии и владение текущим run независимо защищают запись; pause/resume меняют участие, сохраняя открытые намерения                                 | [История](../../packages/core/tests/integration/history.integration.test.ts)                                                                                                     |
| Fork/attach, наследование пользователя и приёмка прямого ребёнка исходным intent; закрытие требует завершения дочерней работы                          | [История](../../packages/core/tests/integration/history.integration.test.ts)                                                                                                     |
| Материалы и снимки имени/ключа документа переживают rename/update, новое участие и открытие БД; отказ записи откатывает checkpoint/ребёнка и поколение | [История](../../packages/core/tests/integration/history.integration.test.ts)                                                                                                     |
| Поиск учитывает предметные тексты, но исключает комментарии и техническое авторство; обзор считает полный состав; doctor проверяет ссылки и граф       | [Запросы](../../packages/core/tests/integration/queries.integration.test.ts)                                                                                                     |
| get/search/overview: отказ при порче связей; doctor проверяет их и active/retired/неизвестные разделы без записи, индекс один; status считает без list | [Запросы](../../packages/core/tests/integration/queries.integration.test.ts)                                                                                                     |
| Предметные чтения Core доступны при удерживаемом writer-lock и не видят незавершённые изменения                                                        | [Чтения при активном писателе](../../packages/core/tests/integration/read-snapshot.integration.test.ts)                                                                          |
| Обзор удерживает состав и поколение, когда другое соединение делает commit между его внутренними чтениями                                              | [Запросы: overview](../../packages/core/tests/integration/queries.integration.test.ts)                                                                                           |
| Требования, задачи, планы и релизы работают совместно; поздний отказ откатывает составную операцию между предметными областями                         | [Рабочий цикл Core](../../packages/core/tests/integration/workflow.integration.test.ts)                                                                                          |

Дополнительные проверки отказов:

- [Задачи](../../packages/core/tests/integration/tasks.integration.test.ts): пустой
  сохранённый заголовок критерия отклоняется при частичной правке; запись, ревизия
  и поколение сохраняются.
- [Планирование](../../packages/core/tests/integration/planning.integration.test.ts):
  изменение состава релиза сохраняет прежний отменённый план, но новое включение
  отменённого плана и перепланирование с ним отклоняются без записи.

[Проекции проекта](../../packages/core/tests/integration/queries-project.integration.test.ts)
проверяют переиспользование загруженного проекта в doctor/overview, активные и снятые
разделы, диагностику повреждения, актуальность между операциями и согласованность
при commit второго соединения. Дополнительные get/getIdentity проекта не требуются.

[Групповое чтение](../../packages/core/tests/integration/queries-get.integration.test.ts)
защищает смешанные виды, полные тексты и вложенные составы, порядок/повторы/алиасы,
типизированные и виртуальные адреса, ошибки отдельных элементов и проекцию снятого раздела.
[Стоимость и снимок](../../packages/core/tests/integration/queries-get-cost.integration.test.ts)
проверяют выборку уникального ограниченного набора, единственный индекс разделов,
отсутствие полной загрузки для summary и конкурентный commit между внутренними чтениями.
[Безымянные задачи](../../packages/core/tests/integration/queries-get-task-titles.integration.test.ts)
сохраняют допустимый пустой/пробельный заголовок в обоих представлениях.

[Версионированное групповое чтение](../../packages/core/tests/integration/queries-get-versioned.integration.test.ts)
сравнивает full/summary-проекцию, порядок, повторы, адресные ошибки и generation
с metadata только успешных ID. Снятый раздел проецируется без изменения raw-источника,
summary не загружает полные записи и журнал. Конкурентная запись между command-port
load отклоняет сменившийся anchor вместо смешанного результата.

[Пакетные сценарии](../../packages/core/tests/integration/batch-workflow.integration.test.ts)
проверяют связанные требования, реализации и задачи, план с этапами и критериями,
перенос с двумя владельцами и неявно изменяемый состав приложения.
[Атомарность](../../packages/core/tests/integration/batch-atomicity.integration.test.ts)
защищает общий rollback, `--check`, исходный CAS и принадлежность локальной ревизии.
[Вложенные результаты](../../packages/core/tests/integration/batch-nested.integration.test.ts)
проверяют адресные поля, историю, FI и структурированные типизированные ссылки.
[Повторная доставка](../../packages/core/tests/integration/batch-replay.integration.test.ts)
сохраняет исходный результат после reopen и последующих изменений, различает
значимые части запроса и не повторяет адресное разрешение либо CAS. Async load не держит
writer-lock; короткий commit проверяет receipt под настоящим `BEGIN IMMEDIATE`.
Доставка между load и commit возвращает выигравшую квитанцию без второго создания;
replay не загружает текущие карточки и полный проект.
[Формат и нормализация](../../packages/core/src/batch/batch-input.unit.test.ts) сохраняют
порядок массивов, строки, исходные адреса и различие пропущенных/явных полей.
[Декодер квитанции](../../packages/core/src/batch/batch-receipt.unit.test.ts) отклоняет
повреждённую оболочку, индекс операции, повтор ID и неверное предметное содержание,
не подменяя ошибку успешным восстановлением.

[Страницы составов планирования](../../packages/core/tests/integration/planning-pages.integration.test.ts)
проверяют загрузку карточек только выбранного окна, порядок включения, total и владельца,
отсутствующие/неверные ссылки внутри и вне окна, повреждённую карточку окна и единый snapshot
при изменении состава вторым соединением. [Составные чтения задач](../../packages/core/tests/integration/task-reads.integration.test.ts)
проверяют однократное чтение владельца, алиасы, сохранность журнала, ошибки вложенных данных
и согласованность владельца с зависимостями при конкурентном commit.

[Стоимость знаний](../../packages/core/tests/integration/knowledge-cost.integration.test.ts)
проверяет однократное чтение целевой карточки, no-op с исходным CAS, адресную проверку
коллизий, выборку участия только своего приложения и согласованность его владельца.
Мутации участия отвергают повреждённую обратную ссылку собственной реализации без
замены её ID, изменения состава, счётчиков и поколения; страничный путь сортирует
отфильтрованный состав один раз.
[Запись контрольных точек](../../packages/core/tests/integration/history-checkpoint-reads.integration.test.ts)
проверяет выборку материалов сессии/намерения и затронутых детей, пакетное принятие и
снимки references, сохранение ошибок повреждённых связей и коллизии ID участия.

### Единый асинхронный исполнитель

[Command executor](../../packages/core/tests/integration/command-executor.integration.test.ts)
проверяет настоящую async-границу `CommandStore`: адресные загрузки без полного проекта,
один commit/outbox, отказ после конкурентной записи без повторного исполнения и
успешную независимую правку после подготовки. Поздний append сохраняется в журнале
и первоначальной квитанции изменения содержания.
[SQLite command port](../../packages/storage/tests/integration/command-port.integration.test.ts)
проверяет stale anchor, положительные и отрицательные предикаты, phantom-вставки,
preview ключа без резервирования, receipt-first commit, rollback counters/aliases/
журналов/ordered tape и исходный инфраструктурный отказ. Отдельные утверждения
проверяют стабильные ID подготовленных эффектов и выборку версий только нужных владельцев.

[Versioned read и запись](../../packages/core/tests/integration/command-version.integration.test.ts)
связывают `expectedVersion` с `versions.aggregateVersion`, отдельно от raw data
и локальной ревизии. Изменение только дочерней части делает старый token устаревшим;
append комментария его не меняет. Проверяются no-op, оба одновременно переданных
предусловия, restore с другой локальной revision и запрет актуализации старого token
в следующем шаге batch.
[Команды знаний](../../packages/core/tests/integration/knowledge-command.integration.test.ts)
проверяют приложение с доской и участием в одном commit, сохранённый снятый раздел
и отказ после phantom-вставки истории приложения без расходования ключа.
[Планирование](../../packages/core/tests/integration/planning-commands.integration.test.ts)
проверяет version-only transfer обоих владельцев, stale targetVersion при свежем
targetRevision, пустой membership predicate и raw scope с клиентским address guard.
[История](../../packages/core/tests/integration/history-commands.integration.test.ts)
сверяет checkpoints с именами/ревизиями каждого шага и отвергает конкурирующий takeover,
занятый после подготовки run ID и нового ребёнка перед закрытием без частичной записи.

Проверки общего resolver не означают, что каждый принимающий ссылку параметр каждого
сервиса проверен отдельно. Аналогично тест одного перехода не доказывает полноту
всех переходов. При изменении сценария сверяйте конкретные входы и утверждения.

## Предметная репликация и переносимое состояние

- [Обмен SQLite-реплик](../../packages/core/tests/integration/replication.integration.test.ts):
  независимые поля, комментарии, отсутствие echo, сохранение поздней локальной записи,
  неделимый batch и независимая доставка при конфликте. Коллизия ключа сохраняет ID,
  не создаёт ложный алиас и не переписывает Markdown. Старый guard даёт `ADDRESS_CHANGED`,
  отсутствие guard после renumber — `ADDRESS_GUARD_REQUIRED`, в том числе после reopen;
  новая локальная правка делает старый fingerprint решения недействительным.
- [Предметные инварианты](../../packages/core/tests/integration/replication-invariants.integration.test.ts)
  сохраняют raw sectionId, проверяют циклы, единственность включения, session/run ownership,
  неизменяемые checkpoints и исторические key snapshots.
  [Составы](../../packages/core/tests/integration/replication-collections.integration.test.ts)
  различают правку/снятие критерия, порядок этапов и снятие FI при конкурентной SI.
- [Причинность](../../packages/core/tests/integration/replication-causality.integration.test.ts)
  связывает запись с созданием нужного ID, но не привязывает независимый комментарий
  к конфликтной правке содержания. [Порядок журнала](../../packages/core/tests/integration/replication-comment-order.integration.test.ts)
  сравнивает публичную выдачу обеих реплик при одинаковых часах и встречных append.
- [Доказательства приёма](../../packages/core/tests/integration/replication-acceptance.integration.test.ts)
  отвергают чужой digest под собственным changesetId и устаревший receipt-only ack
  без очистки очереди; версии слияния сохраняют обоих родителей. Решение не заменяет
  несовместимую первоначальную квитанцию.
- [Атомарный приём](../../packages/core/tests/integration/replication-commit-atomicity.integration.test.ts)
  проверяет поздний SQL-отказ очистки outbox при ACK после импорта: данные, части, квитанция,
  base, поколение и outbox откатываются вместе; повтор сохраняет весь пакет.
- [Ordered publication](../../packages/core/tests/integration/replication-publication.integration.test.ts)
  проверяет переходы на границах каждого шага, в том числе no-op с явной целью;
  complete/publish перед последующим reopen не оцениваются только по конечному snapshot.
  Пропущенная публикация требует chain, подмена ленты отклоняется до ack.
  Локальный CAS не переносится, импорт увеличивает свой guard без обратного echo.
- [Технический source](../../packages/core/tests/integration/replication-technical-source.integration.test.ts)
  отвергает обычную mutation без named tape, техническую маскировку, legacy-гибрид
  и повтор genesis поверх непустой основы, сохраняя canonical state/guard/outbox.
  [Область вложенного перехода](../../packages/core/tests/integration/replication-nested-scope.integration.test.ts)
  связывает targets с реально изменённым этапом/составом и сохраняет независимые
  изменения соседей; отказ не импортирует receipt или частичные эффекты.
- [Custom text](../../packages/core/tests/integration/replication-custom.integration.test.ts)
  сверяет scope конкретной исходной boundary, сохранение остальных эффектов batch,
  original source/receipt и авторство поправки. Незатронутая запись/поле отклоняются;
  независимое продвижение remote не переписывает immutable решение.
- [History capability](../../packages/core/tests/integration/replication-proof.integration.test.ts)
  проверяет точную immutable цель, отказ fabricated token и непроверенного prefix
  перед declared base. При допустимом reuse поздняя локальная запись и pending сохраняются.
- [Ограниченная публикация](../../packages/core/tests/integration/replication-bounded-publication.integration.test.ts)
  проверяет последовательные SQL-окна до decode, неделимый oversized source,
  cursor после reopen, причинный порядок, holes, exact receipts/proofs и локальный остаток.
  Deferred dependencies остаются pending с причинами, не конфликтами.
  [Guards окна](../../packages/core/tests/integration/replication-bounded-guards.integration.test.ts)
  отвергают receipt-only гонку и чужой own digest вне окна, сохраняя поздние записи.
  [Bounded resolve](../../packages/core/tests/integration/replication-bounded-resolution.integration.test.ts)
  сохраняет scoped witness и immutable решение при отдельной доставке causal tail.
- Чистые [Markdown merge](../../packages/core/src/sync-merge/text.unit.test.ts)
  и [порядок ID](../../packages/core/src/sync-merge/order.unit.test.ts) сравнивают точные
  ожидаемые значения: независимые изменения, совпадающие вставки, снятия, конфликтные
  пересечения/циклы, CRLF и непарные surrogate без нормализации.

## Процессы, службы и восстановление Runtime

[Процессный клиент](../../packages/project-runtime/tests/integration/git-sync-process.integration.test.ts)
проверяет stdin-envelope и согласованность ответа с exit code, строгий UTF-8,
большие одновременные потоки, несовместимый override бинарника и discovery с пробелами/
Unicode. [Health supervisor](../../packages/project-runtime/tests/integration/git-sync-supervisor.integration.test.ts)
проверяет capability, физический home и instance через реальный loopback;
живой PID или ответ другого экземпляра не подтверждает readiness.

[Correlation клиента](../../packages/project-runtime/src/git-sync/request-correlation.unit.test.ts)
проверяет назначение operationId до version probe/spawn, неизменность входного объекта
и сохранение ID/code/exit/cause при process timeout. Read/wait с requestId не получает
новый operationId, непрочитанный envelope даёт unknown, достоверные details компонента
не заменяются предположением о результате.

[Службы: unit](../../packages/project-runtime/src/git-sync/service.unit.test.ts)
проверяют unit/plist/XML, точные argv, текущего Windows-пользователя, явные операции
native manager и отдельную health-границу через fixtures. Windows-проверки защищают
quiesce/readback Disabled до End, единый монотонный stop budget и честное состояние
после частичного отказа без unsafe rollback. Это не установка службы
на пользовательском хосте. [Windows XML](../../packages/project-runtime/tests/integration/git-sync-service-format.integration.test.ts)
дополняет генерацию нативным разбором формата на Windows.

[Native lifecycle](../../packages/project-runtime/tests/native/service.native.test.ts)
защищает enable/re-enable, новый instance после самостоятельного restart native manager,
disable и сохранность проекта до cleanup fixture. Windows-сценарий дополнительно проверяет
восстановление после подтверждённого exit 0 и фактическую repetition-конфигурацию одной task.
Это отдельный opt-in набор;
условия запуска и границы проверки login/reboot — в
[организации нативной приёмки](../../tests/README.md#отдельная-нативная-приёмка-служб).

[Общий guardian](../../packages/project-runtime/tests/integration/process-guardian.integration.test.ts)
проверяет bounded drain, deadline/отмену после выхода непосредственного ребёнка,
передачу stdin lease, согласованность протокола и ограничения захвата вывода.
Условия платформ в тесте существенны: escaped-потомки не объявлены частью групповой
гарантии macOS.
[Восстановление](../../packages/project-runtime/tests/integration/restoration.integration.test.ts)
проверяет staging и эксклюзивную публикацию новой БД/конфига, совпадение projectId,
отказ замены рабочей БД, сохранность WAL/SHM и чужого файла при гонке или recovery.
[Поздний writer](../../packages/project-runtime/tests/integration/restoration-late-writer.integration.test.ts)
фиксирует запись вторым процессом после публикации имени БД (no-replace rename на
Linux/macOS, hardlink на Windows) и проверяет сохранность этой ревизии при проигрыше
config и crash, даже при прежнем inode и исчезнувших WAL/SHM.
Повтор возвращает `RESTORE_RECOVERY_REQUIRED` до materializer; сохраняются intent,
рабочая БД и последняя staging-копия, а старое состояние не выдаётся за новый snapshot.
[Явный resume](../../packages/project-runtime/tests/integration/restoration-resume.integration.test.ts)
сравнивает точные данные, `replicaId` и outbox после позднего commit и завершения
локальной привязки. Проверяются ID из конфига/аргумента без home scan, read-only
sync validator, чтение и следующая запись на том же живом public WAL-соединении,
чужой target того же projectId, сохраняющий отказ legacy v1/v2 и скопированного intent,
сомнительные staging-алиасы и отказ validator без публикации. Intent v3 допускает resume
после crash при удалении private marker или staging-каталога. Cleanup failure сохраняет
причину и companion-файл; после полной уборки `RESTORE_NOT_PENDING` не вызывает validator
и не меняет БД.

### Lifecycle Server

[Discovery Server](../../packages/project-runtime/src/server/discovery.unit.test.ts)
отвергает несовместимый явный binary без fallback на другой выпуск.
[Конфигурация службы](../../packages/project-runtime/src/server/service-configuration.unit.test.ts)
сверяет независимость UUID/пути службы и launch без foreground parent lease для
systemd, LaunchAgent и Task Scheduler. Эти unit-проверки не запускают native manager.

[CLI/Runtime lifecycle](../../apps/cli/tests/integration/server-lifecycle.integration.test.ts)
использует реальные тестовые child-процессы и control listener: два экземпляра видны
независимо, остановка одного сохраняет другой, nonce не попадает в публичный JSON.
Проверяются отказ неверного nonce/boot/Origin, занятый lease без health, crash/stale,
сохранность чужого процесса при подмене PID и отказ устаревшего launch. Workspace
сохраняет недоступный элемент и отклоняет один projectId разных физических БД.

[Запуск через Runtime](../../apps/cli/tests/integration/server-native.integration.test.ts)
связывает start/restart/stop с реальным control/mutex тестового процесса, сохранением
контекста и новым bootId. Native manager в этом сценарии подменён. Отдельный foreground
случай использует production guardian и проверяет остановку при отмене CLI.
Эти тесты не заменяют проверку поставляемого HTTP/SPA-бинарника или настоящей login-службы ОС.

## Server, REST SDK и HTTP-контракты

[Команды](../../apps/server/tests/integration/commands.integration.test.ts) проходят через
настоящие loopback HTTP, SDK и файловую SQLite. Утверждения сохраняют точный Markdown
и автора, первоначальную receipt после поздней правки, отклоняют stale CAS/token до no-op
и неверный адресный guard. Неуспешный второй шаг откатывает данные и квитанцию;
`check` сохраняет возможность применить тот же operationKey. Конкурентные HTTP writers
сохраняют одну правку, владелец соединения ожидает async writer перед close.

[Чтения](../../apps/server/tests/integration/reads.integration.test.ts) проверяют
страницы с total/generation, отказ продолжения после внешнего commit и обязательность
поколения для offset. Отдельные assertions защищают root-фильтр задач, false и отсутствие
раздела, ошибки неизвестных фильтров, комментарии/критерии/зависимости, составы этапа и
релиза, session/checkpoint, summary-ошибку отдельного адреса и metadata версий.
Точные counts обзора и согласованные status/doctor проверяются на подготовленном проекте.

[Проекты](../../apps/server/tests/integration/projects.integration.test.ts) подтверждают
независимость workspace-БД, отдельную недоступную регистрацию и отказ двух физических
реплик одного projectId. После перепривязки конфига Git Sync не вызывается для другого
проекта под прежним HTTP ID.

[Транспорт](../../apps/server/tests/integration/transport.integration.test.ts) проверяет
JSON 413 для обычного и потокового body без записи, ошибки JSON/media/Host/Origin,
границу static handler и `INVALID_RESPONSE` SDK с исходным HTTP status. SSE замечает
внешний commit по generation без `list`/графа и заканчивает stream при close.
[Медленный подписчик](../../apps/server/tests/integration/events-backpressure.integration.test.ts)
защищает ограниченную очередь SSE и последнее поколение;
[стандартный порт](../../apps/server/tests/integration/local-policy-default-port.integration.test.ts) —
канонизацию Host/Origin без ослабления loopback-проверки.
[Завершение](../../apps/server/tests/integration/shutdown.integration.test.ts) освобождает
недочитанный HTTP-ввод, включая отказ Origin, и ожидает принятый writer после disconnect.
[Git Sync](../../apps/server/tests/integration/git-sync.integration.test.ts) подтверждает
`refresh:false`, unknown/null/partial, отдельное чтение исхода `now` и точную корреляцию requestId.

[Генерация](../../apps/server/tests/integration/openapi-generation.integration.test.ts)
сопоставляет OpenAPI с реальными Nest-маршрутами и защищает связи схем.
[Команды](../../apps/server/tests/integration/openapi-commands.integration.test.ts) сверяют
формы всех опубликованных операций, пакетные ссылки и guards с Core. Настоящие реализации
фичи/сценария проверяют дискриминацию `targetKind/scenarioId` в данных, карточке и ответе команды;
схема успешного HTTP 200 не принимает ошибочную оболочку.
[Адреса](../../apps/server/tests/integration/address-refs.integration.test.ts) сохраняют
допустимые ключи `.` и `..`, версии и точные query-значения без предварительного разрешения ID.

Интерактивные сценарии Web и границы браузерной приёмки описаны в
[организации наборов](../../tests/README.md#браузерные-сценарии-web).
HTTP-утверждения не означают автоматизированного покрытия поведения React-форм.

## Git-транспорт и постоянный обмен

[Snapshot codec](../../apps/git-sync/src/snapshot/codec.unit.test.ts) сверяет round-trip
первичных записей и частей, безопасные имена, exact Markdown и lossless JSON для
непарных surrogate. Отдельно сохраняются исходный publication payload и исторические
ревизии; неизвестный путь и несовместимый manifest отвергаются.
[Markdown-дескрипторы](../../apps/git-sync/src/snapshot/codec-markdown.unit.test.ts)
проверяют точные bytes/SHA-256, BOM/CRLF/empty/noLF, lone-surrogate fallback и отказ
неверных descriptors/UTF-8. [JSON layout](../../apps/git-sync/src/snapshot/json.unit.test.ts)
защищает lex UTF-16 pretty bytes, numeric-like ключи и duplicate keys.
[Смешанная история layout 1→2](../../apps/git-sync/tests/integration/snapshot-layout.integration.test.ts)
сохраняет DTO, версии, source digests и прежние Git bytes без idle echo. Отказ Core
для layout 1 либо byte digest для layout 2 не меняет SQLite, pending и accepted cursor.
[История Git](../../apps/git-sync/tests/integration/git-history.integration.test.ts)
проверяет пакетное чтение промежуточных snapshots, общие неизменённые blobs и отказ
нелинейной истории/symlink до применения.

[Транспорт](../../apps/git-sync/tests/integration/transport.integration.test.ts)
содержит проверки переиспользования неизменного HEAD, ограниченного числа Git-процессов
для набора файлов, отказа подмены origin/общей истории и безопасного чтения дерева.
[Гонки](../../apps/git-sync/tests/integration/races.integration.test.ts) согласуют
два push одного HEAD и локальную запись во время fetch.
[Обмен](../../apps/git-sync/tests/integration/exchange.integration.test.ts)
проверяет потерянный push-ответ, точный набор ack, сохранение позднего pending,
отсутствие echo, различие ahead и числа changeset, refresh без push/импорта.
[Bounded transport](../../apps/git-sync/tests/integration/bounded-publication.integration.test.ts)
проверяет durable cursor через reopen, пустые окна без ACK, независимый хвост,
реальный pending после одного успешного окна и full diagnostics без hot blocked scan.
[Повторы окна](../../apps/git-sync/tests/integration/bounded-retry.integration.test.ts)
сохраняют исходный cursor/source IDs при non-FF и неизвестном push, а затем принимают
только фактически опубликованные proofs.
[Аварийное восстановление](../../apps/git-sync/tests/integration/crash-recovery.integration.test.ts)
использует реальные выходы процессов после Git commit до push, после принятого push
до локального ack и после SQLite accept до обновления Git cursor. Проверяются исходные
IDs/digests, receipt/comment, поздний pending, локальные версии/части и отсутствие echo
после нового открытия и replay.

[SSH-профиль](../../apps/git-sync/tests/integration/ssh-profile.integration.test.ts)
проверяет foreground-настройки стандартного клиента с сохранением identity/proxy,
точный custom `core.sshCommand` и отсутствие записи maintenance overrides в config.
[Guardian компонента](../../apps/git-sync/tests/process/guardian.process.test.ts)
проверяет обычный exit, output budget, deadline, отмену и смерть владельца до cleanup
fixture. На Linux/Windows отдельные случаи используют subreaper/Job Object;
для macOS остаётся управляемая собственная process group без обещания atomic fork-barrier.
[Foreground lease](../../apps/git-sync/tests/process/foreground-lease.process.test.ts)
связывает SIGKILL прокси с остановкой supervisor/workers и сохранением desired state.
[Resume компонента](../../apps/git-sync/tests/process/restore-resume.process.test.ts)
сохраняет поздний документ и исходный replication status в прежней БД. Git-trap
проверяет отсутствие обращения к Git, результат содержит `sourceCheckpoint: null`;
сочетание resume с remote отклоняется.

[Процессный протокол](../../apps/git-sync/tests/process/protocol.process.test.ts)
проверяет оболочку бинарника, отказ несовместимой версии, restore без предварительной
БД и одного responsive worker, который получает remote при пустом локальном outbox.
[Supervisor](../../apps/git-sync/tests/process/supervisor.process.test.ts)
проверяет обслуживание независимых проектов при общем бюджете, недоступный соседний
origin, новый instance после crash и сохранение desired `stopped`. После настоящего
перезапуска supervisor барьер ждёт reconcile нового instance: остановленная БД
не получает worker, другой проект продолжает публикацию без нового start/auto enable;
настройки и данные сохранены.

[Исход операции](../../apps/git-sync/tests/process/control-outcome.process.test.ts)
отделяет wait deadline от readiness, читает live и terminal состояния одного ID
и не выполняет повторный submit после expiry. [Долгий now](../../apps/git-sync/tests/process/long-now.process.test.ts)
удерживает реальный Git-запрос до барьера: worker остаётся отзывчивым, а request.get
позже возвращает completed. Платформенные условия этого сценария не подменяются
результатом запуска на другой ОС.

[Штатный командный сценарий](../../apps/git-sync/tests/integration/team-replication.integration.test.ts)
проверяет обмен на трёх независимых SQLite/Git-репликах: два активных писателя и offline-return третьего
участника. Он связывает коллизии ключей, настоящий non-FF, потерянный ответ push,
crash с поздней записью, whole-batch конфликт с зависимым и независимым продолжением,
явное решение и restore. Assertions сравнивают исходные ID/ссылки, точные тексты,
первоначальные receipts, публичный порядок комментариев и полный набор source proofs.
Idle всех участников сохраняет локальные CAS, поколения, очереди и Git HEAD без echo.
Подробные варианты этих гарантий остаются в адресных двухрепличных проверках владельцев.
Общая [волна recovery](../../apps/git-sync/tests/integration/team-helpers/team-recovery.ts)
сохраняет позднюю запись между materialization и push и исходный outbox после аварии;
новый процесс публикует те же IDs/digests, которые затем входят в общий exact proof set.

Расширенные сценарии на 50 репликах входят только в
[ручной extended-набор](../../tests/README.md#расширенная-проверка-репликации):
[Git Sync](../../apps/git-sync/tests/extended/team-replication.extended.test.ts) сохраняет
полные командные волны с конфликтом и recovery,
[Core](../../packages/core/tests/extended/replication-team.extended.test.ts) — независимые
offline-назначения, точный набор ID и отсутствие echo после приёма. Их размер не задаёт
обязательный порог CI и не измеряет одновременную пропускную способность.

## CLI: ввод, вывод и соединение компонентов

| Гарантия                                                                                                                                  | Где проверяется                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Конфликт источников отвергается до чтения stdin; пустые значения, false и значимые пробелы сохраняются; JSON из stdin разбирается         | [Модульные проверки ввода](../../apps/cli/src/input/input.unit.test.ts)                                                                                 |
| Текстовый вывод обезвреживает управляющие последовательности, сохраняет Unicode и полное длинное содержание                               | [Модульные проверки вывода](../../apps/cli/src/output/output.unit.test.ts)                                                                              |
| Справка каждой зарегистрированной команды не читает проект/stdin; вызовы изолированы; ошибки аргументов и потоков обрабатываются          | [Модульный запуск CLI](../../apps/cli/src/app/run.unit.test.ts)                                                                                         |
| Глобальные опции принимаются в разных позициях; config/actor из окружения; лишние аргументы отвергаются                                   | [Вызов CLI](../../apps/cli/tests/integration/invocation.integration.test.ts)                                                                            |
| UTF-8 файл/stdin, конфликт источников, неизвестные поля JSON, полное чтение и краткий список                                              | [Ввод и вывод CLI](../../apps/cli/tests/integration/input-output.integration.test.ts)                                                                   |
| Выбор проекта/workspace, доступность чтения при writer-lock, STORAGE_BUSY при записи, защита от подмены базы между выбором и открытием    | [Контекст проекта](../../apps/cli/tests/integration/project-context.integration.test.ts)                                                                |
| Страницы проходят список без повторов до конца, сохраняя размер; курсор чужого проекта/запроса/поколения отклоняется                      | [Пагинация](../../apps/cli/tests/integration/pagination.integration.test.ts), [модульный курсор](../../apps/cli/src/pagination/pagination.unit.test.ts) |
| Базовые списки документов и задач вызывают ограниченное окно Storage, а не полный список карточек                                         | [Пагинация](../../apps/cli/tests/integration/pagination.integration.test.ts)                                                                            |
| Создание/изменение знаний, alias после rename, отсутствие/устаревание ревизии, NOT_FOUND, замена участия                                  | [Знания CLI](../../apps/cli/tests/integration/knowledge.integration.test.ts)                                                                            |
| Новый проект возвращает пустую страницу разделов; создание раздела и документа с section-id, прикрепление типизированной цели и пояснения | [Документы CLI](../../apps/cli/tests/integration/documents.integration.test.ts)                                                                         |
| JSON критериев, завершение критерия и задачи, parent set/clear, dependency add/list, comment add/get/list                                 | [Задачи CLI](../../apps/cli/tests/integration/tasks.integration.test.ts)                                                                                |
| Преобразование полей планов/релизов, позиционный этап, включения задачи, канонический JSON релиза и публикация подготовленного выпуска    | [Планирование CLI](../../apps/cli/tests/integration/planning.integration.test.ts)                                                                       |
| Преобразование operator/runId, чтение намерений и истории, сохранение результата и закрытие участия                                       | [История CLI](../../apps/cli/tests/integration/history.integration.test.ts)                                                                             |
| Поиск и общее адресное чтение, полный счётчик overview при пагинации, status и передача диагностики doctor                                | [Запросы CLI](../../apps/cli/tests/integration/queries.integration.test.ts)                                                                             |

На границе сохранения [интеграция ввода](../../apps/cli/tests/integration/input-output.integration.test.ts)
проверяет `false`, пустой текст, JSON из stdin и пустой `targets` с перечитыванием данных.
[Групповое чтение CLI](../../apps/cli/tests/integration/get.integration.test.ts)
проверяет порядок адресов, полную/краткую форму и частичный результат с ненулевым кодом.
[Пакеты CLI](../../apps/cli/tests/integration/batch.integration.test.ts) соединяют
источники `--input`, проверку без записи, применение и восстановление исходной квитанции.

[Навигация пакетной справки](../../apps/cli/src/commands/batch/help-navigation.unit.test.ts)
проверяет краткий корень, выбор предметной ветки, равнозначность bare/`-h`, автономность
и ленивое раскрытие одного листа. [Метаданные полей](../../apps/cli/src/commands/batch/help.unit.test.ts)
сверяют canonical имена, Markdown, живые enum, адресные и структурированные формы.
[Правила JSON-ввода](../../apps/cli/src/commands/batch/help-contract.unit.test.ts) защищают
обязательность, пропуск, `null`, алиасы и оболочки примеров; [интеграция примеров](../../apps/cli/tests/integration/batch-help-contract.integration.test.ts)
выполняет выбранные пакеты через Core с `check: true` и проверяет исходное состояние после отката.
[Пагинация workspace](../../apps/cli/tests/integration/pagination.integration.test.ts)
проверяет выполнение собственного `nextCommand` при исходном относительном config:
следующая страница сохраняет размер и возвращает оставшуюся регистрацию.

[Контекст проекта CLI](../../apps/cli/tests/integration/project-context.integration.test.ts)
проверяет выбор базы без `databasePath` через `RELAY_HOME` и резервный `HOME/.relay`,
а `config get` возвращает исходные поля и вычисленное расположение в метаданных.
Тот же набор отвергает пустой/пробельный RELAY_HOME без создания файлов и проверяет
относительный корень при явном расположении конфига.

[Фильтры знаний CLI](../../apps/cli/tests/integration/knowledge-filters.integration.test.ts)
проверяют тип приложения, доску приложения, FI/SI выбранной фичи и документы без раздела.
Утверждения охватывают пересечение условий, снятое участие, удалённый раздел, буквальный
ID `none`, явный false, конфликт источников фильтра и сохранение условий в продолжении.

[Списки составов CLI](../../apps/cli/tests/integration/planning-pages.integration.test.ts)
проверяют владельца и порядок страниц, ограниченную загрузку и ранний отказ курсора.
[Вложенные чтения задач CLI](../../apps/cli/tests/integration/task-reads.integration.test.ts)
защищают форму JSON, однократное чтение владельца, продолжения и смену поколения после
комментария без изменения ревизии содержания.

[Адаптер знаний](../../apps/cli/tests/integration/knowledge-reads.integration.test.ts)
проверяет singleton rename без предварительного get и составное чтение участия.
[Курсор поиска](../../apps/cli/tests/integration/search-pagination.integration.test.ts)
защищает отказ по повреждённому, чужому запросу и устаревшему курсору до вызова поиска,
а также однократное вычисление действительного продолжения.

[Макеты вывода](../../apps/cli/src/output/output.unit.test.ts),
[сводка](../../apps/cli/src/output/overview.unit.test.ts) и
[подключение представлений](../../apps/cli/tests/integration/presentation.integration.test.ts)
проверяют вычисленные пути конфигурации, полные комментарии страницы, родителей сессии
внутри и вне окна, снятое участие, отсутствие повторов workspace и сохранение JSON/Markdown.

[Модульный запуск](../../apps/cli/src/app/run.unit.test.ts) проверяет содержательную справку
всего дерева, полный путь вложенной группы, совпадение пустого вызова группы с `--help`,
единственный заголовок и адресные подсказки ошибок, включая параллельные вызовы и JSON.
Адресные случаи защищают объяснения ревизий владельцев, замены наборов и формата критериев.
[Вызов CLI](../../apps/cli/tests/integration/invocation.integration.test.ts) проверяет
подсказку после предметной ошибки ввода Core и отсутствие записи.

[Диагностика аргументов](../../apps/cli/src/app/validation-errors.unit.test.ts) проверяет
компактное объяснение Markdown с начальным дефисом, сохранение других неизвестных флагов
и штатный приоритет help/version. [Запись Markdown](../../apps/cli/tests/integration/dash-markdown.integration.test.ts)
проверяет отсутствие записи при отказе и точный текст, переданный через `--поле=`.

[Async writers CLI](../../apps/cli/tests/integration/async-writers.integration.test.ts)
удерживают соединение до settlement Promise при успехе и отказе; второе SQLite-соединение
может писать, пока обработчик ждёт I/O. [Адресные guards](../../apps/cli/tests/integration/address-guards.integration.test.ts)
проверяют исходные `expectedId` и CAS, отсутствие записи после отказа, raw scope без
предварительного QueryService-чтения и replay receipt до новых guards.
[Пагинация](../../apps/cli/tests/integration/pagination.integration.test.ts)
не включает `--expected-addresses` и версионные write-only флаги в fingerprint/команду
продолжения readonly-запроса.

[Переносимые версии CLI](../../apps/cli/tests/integration/portable-versions.integration.test.ts)
проверяют `get --with-versions` без изменения full/summary-проекции, отдельную
`meta.versions` одного anchor и отказ при конкурентном commit между загрузками.
Token-only запись и оба CAS проверяются независимо от адресного guard; stale token
отклоняет no-op без записи. Отдельные assertions защищают токен существующего product
owner, принадлежность `--target-version` целевому плану, stale `--target-revision`
и атомарный перенос с сохранением задачи.

[Адаптер Git Sync](../../apps/cli/src/commands/git-sync/register.unit.test.ts)
проверяет точную передачу action/options/input, ошибку `now` без retry и сохранение
code/exitCode/details. Одиночный и workspace status сохраняют одинаковую форму items,
частичные ошибки и `null` счётчиков; конфликт сам по себе не делает чтение ошибочным.
Resolve сохраняет JSON из inline/file/stdin, foreground не получает лишний JSON-envelope,
а help/version не открывают проект и не читают stdin.
[Correlation CLI](../../apps/cli/src/commands/git-sync/request.unit.test.ts)
сверяет request get и ожидание now/refresh без operationId, сохранение unknown без
результата и retry, ID в text/JSON ошибке и независимые исходы workspace refresh.
Неверный wait budget, ожидание без refresh и один ID для всего workspace отклоняются до port.
[Blocked-диагностика CLI](../../apps/cli/src/commands/git-sync/blocked.unit.test.ts)
сохраняет оба массива conflicts/blocked, причины ожидания без fingerprint и отказ
resolve blocked без повторного запроса. Full remaining diagnostics и pending
не подменяются ограниченным preview included/deferred/hasMore.
[Адаптер resume](../../apps/cli/src/commands/git-sync/restore.unit.test.ts)
сверяет `resume/projectId`, отсутствие сериализованного undefined, конфликт источников
до запуска компонента, сохранение `recovery.failure` и исходных кодов recovery-ошибок
без retry. Help/version остаются автономными.

[Адаптер Server](../../apps/cli/src/commands/server/register.unit.test.ts) проверяет
автономные help/version всех действий, пустой list без проекта и создания home,
дословные home/config/project/actor и port 0. Отсутствующий UUID stop/restart и неверный
порт отвергаются до discovery компонента.

## Поставляемые бинарники и пользовательские маршруты

[Процессный набор Server](../../apps/server/tests/process/server.process.test.ts)
проверяет автономные help/version без внешних Node-пакетов, Core-запись и первоначальную
квитанцию из перенесённого бинарника, точный авторский контекст и Runtime-регистрацию.
Проверяются байты готовых Vite-файлов, MIME, HEAD/304, SPA fallback и отказ отсутствующего
asset. Несовместимый launch не публикует ready; EOF parent-lease завершает SSE и освобождает
владение. Fixtures закрывают child и потоки также при отказе ожидания.
[Упаковка](../../apps/server/tests/process/embedding.process.test.ts) удаляет build inputs
после компиляции и сверяет встроенные lazy chunks, Workers, шрифты и public assets.
[Процессный shutdown](../../apps/server/tests/process/shutdown.process.test.ts) проверяет
незавершённый ввод, отмену Runtime после grace, удержание lease до cleanup и явный отказ
по deadline с диагностикой stale, а не ложным успешным завершением.

[Процессный набор CLI](../../apps/cli/tests/process/cli.process.test.ts) проверяет
встроенную версию, код/поток ошибки ввода, несколько форм вложенной справки,
неизвестное действие и закрытый stdout. Вызовы выполняются без настроенного проекта
и проверяют отсутствие созданных файлов.

[Примеры справки](../../apps/cli/tests/process/help-examples.process.test.ts) проходят
настоящую оболочку с заглушкой `relay`, затем парсер CLI с остановкой до обработчика.
У каждого действия проверяется наличие собственного примера выполнения. Представители
создания задачи, релиза и намерения выполняются через `runCli` на изолированных fixtures:
проверяются точный Markdown и критерий, версия и состав релиза, участие и ревизия сессии.

[Shell completion](../../apps/cli/tests/process/completion.process.test.ts) проверяет
кандидатов вложенных команд, глобальные флаги и enum, генерацию скриптов четырёх оболочек,
ошибку неизвестного shell и закрытый stdout. Запросы выполняются с открытым пустым stdin
и изолированным HOME. Bash-транспорт проходит через настоящий бинарник: пробелы,
буквальная командная подстановка, пустое слово, значение через `=` и повторное подключение.
Записывающая обёртка дополнительно сверяет точные границы argv перед реальным бинарником.
Завершённый `--option=value` сохраняет последующие подсказки, а отказ вывода плагина
в `/dev/full` на Linux возвращает ошибку вместо ложного успеха.
Завершённый разделитель `--` прекращает подсказки параметров, а текущее `--` под курсором
сохраняет предложение флагов; проверены прямой протокол и Bash-транспорт.
Слияние глобальных и локальных enum, скрытые поля и перекрытие аргумента защищены
[модульно](../../apps/cli/src/app/completion-candidates.unit.test.ts).

[Сквозной набор](../../tests/e2e/local-workflow.e2e.test.ts) запускает новый бинарник
на каждом шаге четырёх маршрутов:

1. Документ: полный Markdown, чтение между процессами и защита прочитанной ревизией.
2. Workspace: независимые проекты, явный выбор и сохранение базы после удаления регистрации.
3. Задача с критерием: выполнение, завершённый план и фиксация релиза.
4. История: сохранённое намерение и явный результат участия.

[Пакетная декомпозиция](../../tests/e2e/batch-workflow.e2e.test.ts) соединяет проверку
JSON-файла, применение через stdin, локальные ссылки фичи/сценария/задачи, публикацию
нового документа с архивированием прежнего, полное и краткое групповое чтение.
Отдельные запуски восстанавливают квитанцию и повторяют исходный пакет с тем же ключом.

Новые пользовательские маршруты Git Sync разделены по наблюдаемой гарантии:

- [Обмен и restore](../../tests/e2e/git-sync-workflow.e2e.test.ts) сохраняет две записи
  с первоначально одинаковым ключом, ID-связи и независимые поля через реальные бинарники.
- [Конфликт](../../tests/e2e/git-sync-conflict.e2e.test.ts) проверяет `now` с exit 4 /
  `SYNC_CONFLICT`, успешный status, полные base/local/remote и доставку решения
  с прочитанным fingerprint.
- [Worker](../../tests/e2e/git-sync-worker.e2e.test.ts) проверяет readiness `auto enable`,
  тот же instance из следующего CLI-процесса и сохранение stopped без ложного retry.

[CLI/Server/Web/Git Sync](../../tests/e2e/server-web-workflow.e2e.test.ts) запрашивает
встроенный HTML и production JavaScript у копии `relay-server` вне каталога сборки.
Документ, созданный через HTTP, читается через CLI с точным Markdown; поздняя CLI-правка
отклоняет исходный token HTTP-формы, replay и receipt сохраняют первоначальный результат.
Явный HTTP `now` доставляет актуальную запись, а restore второй реплики сохраняет её ID
и содержание. Этот маршрут проверяет поставку Web и API, не исполняя UI в браузере.

## Границы карты

- Общие правила идентичности, декодеры знаний/истории и чистый граф задач проверяются
  модульными наборами Contracts, CLI и Core без SQLite;
  сохранение, транзакции и предметная интеграция — с реальной БД.
  Наличие unit-теста не заменяет проверку границы хранения.
- Ограниченное чтение карточек проверяется для базовых страниц без предметных фильтров
  и явных составов этапа/релиза.
  Это не утверждение об ограниченной стоимости всех поисков и вычисляемых списков.
- Технические миграции SQLite, включая нормализацию v4, проверяются отдельно от переноса
  данных первой реализации Relay; перенос её JSON-хранилища не входит в эти проверки.
- [CI-матрица](../../.github/workflows/ci.yml) задаёт нативные Linux/macOS/Windows-запуски.
  Генератор конфигурации, fake manager и Linux-прогон группового примитива не являются
  нативной приёмкой другой ОС. Платформенные условия и границы ownership читаются
  вместе с конкретными assertions; macOS не обещает containment произвольных daemonized helpers.
- Конкурентные функциональные случаи и SIGKILL владельца mutex не измеряют предел
  пропускной способности и не доказывают устойчивость всех данных к отключению питания.
- Измерения количества команд в секунду, p95/p99, памяти и пределов размера проекта
  относятся к [ручной нагрузке](CLI-PERFORMANCE.md); исполняемый стенд пока не создан.
- Настоящий native lifecycle Server, интерактивные browser-сценарии и HTTP-сценарии имеют
  разные границы. Fake manager и выдача Web assets не подтверждают запуск службы после
  login/reboot или работу форм в браузере.
- Удалённый CLI, PostgreSQL, MCP и перенос данных первой версии остаются отложенными
  и не считаются покрытыми этими наборами.

При изменении гарантии обновите соответствующую строку и ссылку. Если проверка удалена,
укажите оставшееся подтверждение либо уберите утверждение о покрытии. Новые случаи
добавляются по риску, а не ради заполнения всех клеток таблицы.
