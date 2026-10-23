import type {
  BatchIdentity,
  BatchItemResult,
  BatchOperationDescription,
  BatchOutput,
  BatchResultKind,
  BatchRevisionOwner,
  BatchRevisionReference,
  BatchReference,
} from "@relay/contracts";

/**
 * Конечное JSON-значение пакета после проверки внешней границы.
 */
export type BatchJson = null | boolean | number | string | readonly BatchJson[] | BatchObject;

/**
 * Словарь JSON только на границе адаптации к предметному декодеру.
 */
export interface BatchObject {
  /* Собственные JSON-поля без undefined, функций и нестандартных прототипов. */
  readonly [field: string]: BatchJson;
}

/**
 * Независимая копия запроса и его идентичность, подготовленные до транзакции писателя.
 * Предметная оболочка ещё не проверена: первоначальная квитанция имеет приоритет перед её разбором.
 */
export interface PreparedBatchInput {
  /* Конечное JSON-дерево с каноническим порядком свойств, без разрешения адресов. */
  readonly input: BatchJson;
  /* Размер сериализованного input в байтах UTF-8, без оболочки автора. */
  readonly inputBytes: number;
  /* Канонический JSON исходного запроса и дословного проверенного автора для сравнения квитанций. */
  readonly requestJson: string;
}

/**
 * Проверенная оболочка шага; содержание input проверяется владельцем предметного действия.
 */
export interface BatchStep {
  /* Имя зарегистрированного действия. */
  readonly op: string;
  /* Локальное имя либо null при отсутствии. */
  readonly as: string | null;
  /* Пользовательский адрес основной записи; отсутствует у singleton и создания. */
  readonly ref?: string | BatchReference;
  /* Явный CAS либо ссылка на правильного владельца предыдущего результата. */
  readonly ifRevision?: number | BatchRevisionReference;
  /* Изолированное JSON-содержание без нормализации пользовательских строк. */
  readonly input: BatchObject;
}

/**
 * Результат предметного адаптера до добавления координат шага.
 */
export interface BatchOutcome {
  /* Основной выход, на ID которого ссылается $ref. */
  readonly primary: BatchIdentity;
  /* Владелец ревизии для $revision. */
  readonly owner: BatchRevisionOwner;
  /* Дополнительные компактные выходы. */
  readonly outputs: readonly BatchOutput[];
}

/**
 * Объявленное адресное поле; рекурсивная интерполяция произвольного JSON запрещена.
 */
export interface BatchAddressField {
  /* Путь внутри input; * посещает только элементы объявленного массива. */
  readonly path: string;
  /* Допустимые виды локального результата; пусто означает любой самостоятельный вид. */
  readonly kinds: readonly BatchResultKind[];
}

/**
 * Предметное действие с публичным каталогом и синхронным адаптером существующего сервиса.
 */
export interface BatchActionDescriptor {
  /* Публичная форма ввода и владелец CAS. */
  readonly description: BatchOperationDescription;
  /* Единственные адресные позиции для раскрытия локальных ссылок. */
  readonly addresses: readonly BatchAddressField[];
}

/**
 * Синхронный адаптер предметного сервиса; тип контекста передаёт сборка исполнителя.
 */
export interface BatchAction<Context> extends BatchActionDescriptor {
  /* Исполнитель одного предметного действия внутри внешней транзакции. */
  readonly execute: (context: Context) => BatchOutcome;
}

/**
 * Параметры декларации предметного адаптера; отсутствие ref/revisionOwner означает создание.
 */
export interface BatchActionOptions {
  /* Русское описание назначения и владельца. */
  readonly description: string;
  /* true требует верхнеуровневый адрес; иначе ref запрещён. */
  readonly ref?: boolean;
  /* Имя владельца обязательной ревизии; отсутствие запрещает ifRevision. */
  readonly revisionOwner?: string;
  /* Разрешённые адресные позиции input; остальные значения не интерполируются. */
  readonly addresses?: readonly BatchAddressField[];
}

/**
 * Состояние исключительно одного запуска пакета, не сохраняемое между вызовами сервиса.
 */
export interface BatchExecutionState {
  /* Уже завершённые локальные имена; ссылки вперёд отсутствуют в Map. */
  readonly aliases: Map<string, BatchItemResult>;
  /* Новые либо уже явно проверенные числовым CAS владельцы. */
  readonly authorizedOwners: Set<string>;
  /* ID итоговой выдачи в порядке первого касания. */
  readonly touched: Set<string>;
}
