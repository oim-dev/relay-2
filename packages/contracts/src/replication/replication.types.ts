import type { EntityRecord } from "../entities/entity.types";
import type { PortableComponent } from "../components/component.types";
import type { CommandSelector } from "../commands/command-store.types";
import type { TaskComment } from "../tasks/tasks.types";

/**
 * Сохранённая переносимая карточка без технического CAS конкретной SQLite.
 * Числовые исторические ревизии внутри data сохраняются дословно.
 */
export type PortableEntityRecord = Omit<EntityRecord, "revision">;

/**
 * Сохранённая карточка и её переносимая версия; revision остаётся локальным CAS.
 * version — SHA-256 канонического содержимого без revision и независимого журнала.
 */
export interface PortableEntity {
  /* Полная сохранённая карточка; data.comments отсутствует, проекции не экспортируются. */
  readonly record: PortableEntityRecord;
  /* Отпечаток содержания и метаданных, независимый от локальной ревизии SQLite. */
  readonly version: string;
  /* Непосредственные версии-предки, отсортированные без повторов; отсутствие у старой формы равно []. */
  readonly parents?: readonly string[];
}

/**
 * Занятый адрес проекта. Принятые назначения и алиасы сохраняются при обмене.
 */
export interface PortableAddress {
  /* ID, текущий ключ либо исторический алиас в едином пространстве адресов. */
  readonly ref: string;
  /* Постоянный ID владельца адреса. */
  readonly entityId: string;
}

/**
 * Неизменяемый комментарий с переносимым порядком, независимым от SQLite sequence.
 */
export interface PortableComment {
  /* Постоянный ID задачи-владельца. */
  readonly taskId: string;
  /* Сохранённый комментарий без преобразования Markdown и авторства. */
  readonly comment: TaskComment;
  /* ID предыдущего комментария этого журнала либо null; параллельные ветви упорядочиваются по ID. */
  readonly after: string | null;
}

/**
 * Первоначальная неизменяемая пользовательская квитанция, отдельная от подтверждений доставки.
 */
export interface PortableBatchReceipt {
  /* Уникальный ключ пользовательского пакета в проекте. */
  readonly operationKey: string;
  /* Точная исходная нормализованная JSON-строка запроса с автором. */
  readonly requestJson: string;
  /* Точная JSON-строка первоначального результата, включая исторические ключи. */
  readonly resultJson: string;
}

/**
 * Компактные подтверждения одной реплики; интервалы включительны, отсортированы и не пересекаются.
 * Пропуски сохраняются: конфликтный changeset не блокирует независимые последующие записи.
 */
export interface ReplicationConfirmation {
  /* Случайный постоянный ID SQLite-реплики; восстановление получает новый ID. */
  readonly replicaId: string;
  /* Принятые последовательности changeset; соседние интервалы объединяются. */
  readonly ranges: readonly (readonly [number, number])[];
  /* Точные digest исходных changeset; реальные снимки Core сохраняют proof для каждой принятой sequence. */
  readonly proofs?: readonly ReplicationAcceptanceProof[];
}

/**
 * Компактное доказательство идентичности принятого payload без хранения самого changeset в дереве.
 */
export interface ReplicationAcceptanceProof {
  /* Положительный номер changeset в данной реплике. */
  readonly sequence: number;
  /* SHA-256 канонического исходного payload; одинаковый ID с другим digest запрещён. */
  readonly digest: string;
  /* ID публикации, в которой проверены эффекты; отсутствие только у draft-v3 checkpoint. */
  readonly publicationId?: string;
  /* Неизменяемое решение либо null; отсутствие только у draft-v3 checkpoint. */
  readonly resolutionId?: string | null;
  /* Отпечаток эффективной упорядоченной ленты, связанной с публикацией. */
  readonly effectDigest?: string;
  /* Отклонение исходных эффектов не разрешает автоматически зависимые изменения. */
  readonly outcome?: "applied" | "discarded";
}

/**
 * Полный переносимый снимок текущего состояния, без путей, SQL и локальных счётчиков.
 * Коллекции имеют уникальные ID/адреса и канонический порядок по идентификатору.
 */
export interface PortableProjectSnapshot {
  /* Версия переносимого формата, независимая от версии схемы SQLite. */
  readonly formatVersion: 1;
  /* Модель нормализованных владельцев без local CAS; отсутствие — прежний draft. */
  readonly modelVersion?: 2;
  /* Неизменяемый ID проекта, совпадающий с единственной карточкой project. */
  readonly projectId: string;
  /* Полные сохранённые карточки по ID. */
  readonly entities: readonly PortableEntity[];
  /* Первичные независимые части, включая tombstones; обязательны в модели 2. */
  readonly components?: readonly PortableComponent[];
  /* Все текущие адреса и сохранённые алиасы по ref. */
  readonly addresses: readonly PortableAddress[];
  /* Append-only комментарии по ID, с явным порядком after. */
  readonly comments: readonly PortableComment[];
  /* Первоначальные квитанции по operationKey. */
  readonly receipts: readonly PortableBatchReceipt[];
  /* Подтверждения атомарных changeset по replicaId. */
  readonly confirmations: readonly ReplicationConfirmation[];
  /* Только последняя публикация; null у локального capture без публикации. */
  readonly publication?: ReplicationPublication | null;
}

/**
 * Изменение одной сохранённой карточки, схлопнутое за внешнюю транзакцию.
 */
export interface ReplicatedEntityChange {
  /* Постоянный ID владельца; совпадает с обеими ненулевыми версиями. */
  readonly id: string;
  /* Состояние перед транзакцией; null при создании. */
  readonly before: PortableEntity | null;
  /* Состояние после транзакции; null только при явном согласовании удаления. */
  readonly after: PortableEntity | null;
}

/**
 * Атомарная durable-запись одной внешней предметной транзакции.
 */
export interface ReplicationChangeset {
  /* Версия неизменяемого payload доставки. */
  readonly formatVersion: 1;
  /* Постоянный ID проекта, которому принадлежит транзакция. */
  readonly projectId: string;
  /* SHA-256 полного канонического payload без этого поля. */
  readonly digest: string;
  /* baseline — однократный перенос существующей базы; mutation — проверенная предметная транзакция. */
  readonly mode: "baseline" | "mutation";
  /* Глобальный ID вида replicaId:sequence. */
  readonly id: string;
  /* ID породившей реплики. */
  readonly replicaId: string;
  /* Монотонный номер, выделенный атомарно вместе с изменениями. */
  readonly sequence: number;
  /* Время сохранения для диагностики возраста очереди, не для выбора победителя. */
  readonly createdAt: string;
  /* Последние changeset фактически изменённых владельцев; не глобальная цепочка. */
  readonly dependencies: readonly string[];
  /* Предметно прочитанные ID/версии, включая создание целей структурированных ссылок. */
  readonly readContext: readonly ReplicationReadGuard[];
  /* Модель raw owners; отсутствие сохраняет исходную legacy-форму и её digest. */
  readonly modelVersion?: 2;
  /* Независимые части той же атомарной транзакции; отсутствие только у legacy payload. */
  readonly components?: readonly ReplicatedComponentChange[];
  /* Эффекты в порядке command boundaries до SQL collapse; отсутствуют у draft-v3. */
  readonly transitions?: readonly ReplicationTransition[];
  /* Карточки с исходными и конечными версиями; порядок по ID. */
  readonly entities: readonly ReplicatedEntityChange[];
  /* Новые назначения адресов, включая алиасы обычного rename. */
  readonly addresses: readonly PortableAddress[];
  /* Добавленные неизменяемые комментарии. */
  readonly comments: readonly PortableComment[];
  /* Добавленные неизменяемые пользовательские квитанции. */
  readonly receipts: readonly PortableBatchReceipt[];
}

/**
 * Дельта независимо версионируемой части; снятие выражается after.deleted, а не потерей ID.
 */
export interface ReplicatedComponentChange {
  /* Составной PK ownerId/kind/id в JSON-представлении массива строк. */
  readonly key: string;
  /* Исходная часть либо null у нового включения. */
  readonly before: PortableComponent | null;
  /* Новая версия, включая явный tombstone снятия. */
  readonly after: PortableComponent;
}

/**
 * Уже рассчитанная атомарная граница команды; source effects не исполняются заново.
 */
export interface ReplicationTransition {
  /* Предметный идентификатор перехода; legacy обозначает адаптацию старого payload. */
  readonly command: string;
  /* Автор исходной операции, без нормализации. */
  readonly actor: string;
  /* Время уже подготовленной команды; отсутствует только у legacy/технической atomic boundary. */
  readonly timestamp?: string;
  /* Обязательны у именованной modelVersion=2 команды, включая no-op; отсутствуют у технической/legacy. */
  readonly targets?: ReplicationTransitionTargets;
  /* Упорядоченные изменения владельцев этой команды. */
  readonly entities: readonly ReplicatedEntityChange[];
  /* Изменения независимо хранимых частей этой команды. */
  readonly components: readonly ReplicatedComponentChange[];
  /* Новые сохранённые адреса. */
  readonly addresses: readonly PortableAddress[];
  /* Неизменяемые дополнения журналов. */
  readonly comments: readonly PortableComment[];
  /* Первоначальные квитанции, включая исторические числовые ревизии. */
  readonly receipts: readonly PortableBatchReceipt[];
  /* Версии контекста, прочитанного до этой границы; Core повторно проверяет предикаты. */
  readonly readContext: readonly ReplicationReadGuard[];
  /* Логические положительные и отрицательные предикаты; без локальных CAS fingerprint. */
  readonly predicates?: readonly ReplicationPredicate[];
}

/**
 * Постоянные ID проверяемых целей без эвристики порядка прочитанных записей.
 */
export interface ReplicationTransitionTargets {
  /* Основной результат именованной команды; null разрешён только технической границе. */
  readonly primaryId: string | null;
  /* Владельцы проверяемой записи/CAS, включая обе стороны transfer. */
  readonly ownerIds: readonly string[];
  /* Обязательны у именованной команды; роли зависят от её каталога, null сохраняет явное снятие. */
  readonly roles?: Readonly<Record<string, string | null>>;
}

/**
 * Переносимая выборка обязательств, проверяемая на каждом effective boundary.
 */
export interface ReplicationPredicate {
  /* Смысл выборки, включая отсутствие; техническое резервирование key сюда не входит. */
  readonly selector: Exclude<CommandSelector, { readonly kind: "key" | "summaries" }>;
  /* Полный упорядоченный набор найденных ID и версий; пустой массив защищает отрицание. */
  readonly records: readonly { readonly id: string; readonly version: string | null }[];
  /* Результат boolean/existence выборки; null у наборов записей. */
  readonly present: boolean | null;
}

/**
 * Неизменяемое явное решение, переносимое вместе с публикацией и доступное через Git history.
 */
export type ReplicationResolution = ReplicationDecision & ReplicationResolutionMaterial;

/**
 * Неизменяемая переносимая основа решения, отдельная от первоначального payload changeset.
 */
export interface ReplicationResolutionMaterial {
  /* Версия material/remoteDigest: 1 связывает точную просмотренную область конфликта. */
  readonly formatVersion: 1;
  /* SHA-256 материала решения без этого поля; новое решение всегда имеет новую идентичность. */
  readonly resolutionId: string;
  /* ID исходной атомарной мутации. */
  readonly changesetId: string;
  /* Digest неизменённого исходного payload. */
  readonly sourceDigest: string;
  /* Дословное авторство решения. */
  readonly actor: string;
  /* Время создания решения, выделенное один раз; не определяет победителя слияния. */
  readonly createdAt: string;
  /* Отпечаток просмотренных remote records/parts/journals/receipts и полной карты адресов. */
  readonly remoteDigest: string;
  /* Полные просмотренные стороны для проверки fingerprint и аудита решения. */
  readonly material: ReplicationConflict;
}

/**
 * Связь конкретной мутации с принятым результатом без self-reference Git SHA.
 */
export interface PublicationAcceptance {
  /* Постоянный ID исходного changeset. */
  readonly changesetId: string;
  /* Digest первоначального payload, не merge-кандидата. */
  readonly sourceDigest: string;
  /* ID отдельного решения либо null. */
  readonly resolutionId: string | null;
  /* Digest точной эффективной ленты этой мутации. */
  readonly effectDigest: string;
}

/**
 * Материал одной мутации данной публикации; прежние публикации остаются в Git history.
 */
export interface PublicationChange {
  /* Первоначальная неизменяемая транзакция с выделенными ID/временами. */
  readonly source: ReplicationChangeset;
  /* Явное решение либо null для обычного согласования. */
  readonly resolution: ReplicationResolution | null;
  /* Реально принятые переходы с версиями согласованного контекста. */
  readonly transitions: readonly ReplicationTransition[];
}

/**
 * Связь с проверенным непосредственным предком публикации.
 */
export interface PublicationParent {
  /* ID предыдущей публикации; null допустим лишь для явного legacy checkpoint. */
  readonly publicationId: string | null;
  /* Digest всех первичных данных и confirmations предка, кроме publication. */
  readonly snapshotDigest: string;
}

/**
 * Проверяемый переход от предка к новому снимку; хранится только последняя публикация.
 */
export interface ReplicationPublication {
  /* Версия материала публикации, отдельная от SQL и process protocol. */
  readonly formatVersion: 1;
  /* Digest родителя, принятых source/effects и результата без собственного ID. */
  readonly publicationId: string;
  /* Непосредственный предок; null только у genesis. */
  readonly parent: PublicationParent | null;
  /* Digest primary snapshot без publication и новых confirmation bindings. */
  readonly snapshotDigest: string;
  /* Точный упорядоченный набор принятых мутаций с исходными digest. */
  readonly accepted: readonly PublicationAcceptance[];
  /* Источники и эффективные переходы в том же порядке, что accepted. */
  readonly changes: readonly PublicationChange[];
}

/**
 * Необходимые промежуточные публикации от принятого предка до remote.
 */
export interface ReplicationHistoryInput {
  /* Снимки в прямом порядке; remote последним необязателен, повтор удаляется. */
  readonly chain?: readonly PortableProjectSnapshot[];
}

/**
 * Восстановление из genesis-цепочки либо явно доверенного transport checkpoint.
 */
export interface ReplicationBootstrapOptions extends ReplicationHistoryInput {
  /* true означает, что приложение уже установило доверие к checkpoint canonical Git history. */
  readonly trustedCheckpoint?: boolean;
}

/**
 * Прочитанное основание эффекта внутри одного write unit-of-work.
 */
export interface ReplicationReadGuard {
  /* Постоянный ID прочитанного владельца, не пользовательский ключ. */
  readonly id: string;
  /* existence фиксирует существование ID, content также сохраняет прочитанную версию содержания. */
  readonly kind: "existence" | "content";
  /* Переносимая content версия; null у existence-чтения или созданного внутри транзакции ID. */
  readonly version: string | null;
  /* Источник локальной версии/создания; null для импортированного или созданного в этой транзакции ID. */
  readonly sourceChangesetId: string | null;
  /* Digest полного raw aggregate без local revision/comments; присутствует у содержательного entity-read. */
  readonly logicalDigest?: string;
}

/**
 * Сохранённый конфликт целого changeset с исходными тремя сторонами.
 */
export interface ReplicationConflict {
  /* Стабильный ID конфликтующего changeset. */
  readonly id: string;
  /* Отпечаток remote и текущих локальных владельцев для защиты решения от устаревания. */
  readonly fingerprint: string;
  /* Предметный код причины либо REPLICATION_DEPENDENCY. */
  readonly code: string;
  /* Русское описание причины. */
  readonly message: string;
  /* Полная атомарная локальная транзакция с base/after. */
  readonly changeset: ReplicationChangeset;
  /* Текущие локальные версии затронутых владельцев. */
  readonly local: readonly PortableEntity[];
  /* Принятые удалённые версии затронутых владельцев. */
  readonly remote: readonly PortableEntity[];
  /* Точные локальные первичные части затронутых владельцев, включая снятия. */
  readonly localComponents?: readonly PortableComponent[];
  /* Принятые удалённые части тех же владельцев для полного материала решения. */
  readonly remoteComponents?: readonly PortableComponent[];
  /* Локальные неизменяемые журналы, участвующие в fingerprint просмотренного конфликта. */
  readonly localComments?: readonly PortableComment[];
  /* Удалённые комментарии затронутых журналов, включая несовместимый payload того же ID. */
  readonly remoteComments: readonly PortableComment[];
  /* Удалённые первоначальные квитанции конфликтующих operationKey, без подмены локальных. */
  readonly remoteReceipts: readonly PortableBatchReceipt[];
  /* Назначения затронутых владельцев и столкнувшихся адресов из принятого remote. */
  readonly remoteAddresses: readonly PortableAddress[];
  /* Позднее локальное решение, которое не было принято вместе с уже опубликованным source. */
  readonly pendingResolution?: ReplicationResolution;
  /* Фактически принятое решение при REPLICATION_RESOLUTION_STALE; null означает приём без решения. */
  readonly acceptedResolutionId?: string | null;
}

/**
 * Явное решение целого changeset; произвольная JSON-мутация не принимается.
 */
export type ReplicationDecision = ReplicationSideDecision | ReplicationCustomDecision;

/**
 * Выбор одной из просмотренных сторон целого атомарного изменения.
 */
export interface ReplicationSideDecision {
  /* Отпечаток из последнего conflicts()/prepare(). */
  readonly fingerprint: string;
  /* local выбирает локальные конфликтующие поля, remote отклоняет весь changeset. */
  readonly choice: "local" | "remote";
}

/**
 * Custom v1: замена конкретных изменённых текстовых полей существующего документа в исходной tape.
 * Остальные эффекты проходят обычный merge; изменения истории, адресов, состава или receipts запрещены.
 */
export interface ReplicationCustomDecision {
  /* Отпечаток из последнего conflicts()/prepare(). */
  readonly fingerprint: string;
  /* Явно выбирает закрытый text patch contract. */
  readonly choice: "custom";
  /* Непустой набор уникальных transition/entityId/field; значения сохраняются дословно. */
  readonly patch: readonly ReplicationDocumentTextPatch[];
}

/**
 * Одна авторская текстовая поправка внутри первоначального changeset без произвольного JSON path.
 */
export interface ReplicationDocumentTextPatch {
  /* Нулевой индекс исходной command boundary; у legacy atomic payload допускается только 0. */
  readonly transition: number;
  /* Постоянный ID существующего document, изменённого этой границей. */
  readonly entityId: string;
  /* Только mutable текстовые поля документа; поле должно действительно изменяться исходным эффектом. */
  readonly field: "name" | "summary" | "body";
  /* Точное пользовательское значение, включая lossless UTF-16 тела/названия; проверяется Core. */
  readonly value: string;
}

/**
 * Кандидат публикации; подготовка не является подтверждением remote acceptance.
 */
export interface PreparedReplication {
  /* Кандидат общей ветки: remote плюс только готовые атомарные changeset. */
  readonly snapshot: PortableProjectSnapshot;
  /* Локальное поколение, из которого выполнялась подготовка. */
  readonly generation: number;
  /* ID включённых локальных changeset, ещё не подтверждённых remote. */
  readonly included: readonly string[];
  /* Действительные конфликты рассмотренных sources; ожидание dependencies сюда не входит. */
  readonly conflicts: readonly ReplicationConflict[];
}

/**
 * Диагностика локальной реплики без сетевых обращений.
 */
export interface ReplicationStatus {
  /* Постоянный ID этой SQLite-реплики. */
  readonly replicaId: string;
  /* Поколение предметных данных. */
  readonly generation: number;
  /* Локальная версия очереди/согласования; меняется и при receipt-only или техническом ack. */
  readonly transportVersion: number;
  /* Число неподтверждённых атомарных транзакций. */
  readonly pending: number;
  /* Время старейшей неподтверждённой транзакции либо null. */
  readonly oldest: string | null;
  /* Число сохранённых конфликтов. */
  readonly conflicts: number;
}

/**
 * Итог атомарного приёма реально опубликованного снимка.
 */
export interface ReplicationAcceptResult {
  /* ID удалённых из outbox только после подтверждения общей веткой. */
  readonly acknowledged: readonly string[];
  /* Актуальное поколение после согласования. */
  readonly generation: number;
  /* Сохранённые конфликты, не уничтожающие более поздние локальные записи. */
  readonly conflicts: readonly ReplicationConflict[];
  /* false означает, что локальный конфликт препятствует согласованному импорту части remote. */
  readonly reconciled: boolean;
}

/**
 * Защита сохранённого пользовательского адреса от переназначения предварительного ключа.
 */
export interface ExpectedEntityAddress {
  /* Исходный ID, ключ, алиас или типизированный адрес пользователя. */
  readonly ref: string;
  /* Постоянный ID, который пользователь видел при чтении адреса. */
  readonly expectedId: string;
}
