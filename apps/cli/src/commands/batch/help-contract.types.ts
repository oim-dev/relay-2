/**
 * JSON-значение автономного примера операции; undefined, функции и служебные объекты исключены.
 */
export type BatchExampleValue =
  string | number | boolean | null | readonly BatchExampleValue[] | BatchExampleObject;

/**
 * JSON-объект примера с рекурсивно проверяемыми значениями.
 */
export interface BatchExampleObject {
  /* Имена предметных полей; вложенные значения остаются обычным JSON. */
  readonly [field: string]: BatchExampleValue;
}

/**
 * Самостоятельный пример одного шага, не зависящий от необъявленных локальных имён as.
 * Адреса и ревизии условны; перед выполнением их заменяют данными выбранного проекта.
 */
export interface BatchExampleOperation {
  /* Точное имя предметной операции из BATCH_OPERATIONS. */
  readonly op: string;
  /* Условный адрес существующего владельца; отсутствует у singleton и создания. */
  readonly ref?: string;
  /* Условная положительная ревизия владельца CAS; отсутствует у операций без CAS. */
  readonly ifRevision?: number;
  /* Только разрешённые предметные поля input; отсутствие означает пустой объект. */
  readonly input?: BatchExampleObject;
}

/**
 * Предметная семантика JSON-поля, независимая от required/default схемы CLI-флагов.
 */
export interface BatchFieldContract {
  /* Реальная обязательность, включая условие одного из альтернативных полей. */
  readonly presence: string;
  /* Результат пропуска поля: отказ, начальное значение, сохранение либо условная альтернатива. */
  readonly omission: string;
  /* Разрешён ли явный JSON null именно у этого верхнеуровневого поля input. */
  readonly nullable: boolean;
  /* Смысл явного null; существует только у nullable-поля. */
  readonly nullMeaning?: string;
}

/**
 * Предметные предусловия и готовый JSON-пример одного листа справки batch.
 */
export interface BatchOperationContract {
  /* Короткие предметные правила в порядке чтения; общий протокол batch не повторяется. */
  readonly rules: readonly string[];
  /* Полная оболочка одного шага с подходящим владельцем условной ревизии. */
  readonly example: BatchExampleOperation;
}

/**
 * Внутреннее определение листа вместе с явной политикой каждого поля input.
 */
export interface BatchHelpContractDefinition extends BatchOperationContract {
  /* Политики ровно допустимых полей; отсутствие политики считается дефектом метаданных. */
  readonly fields: Readonly<Record<string, BatchFieldContract>>;
}

/**
 * Ленивое создание подробностей ровно одной операции из статических описаний версии кода.
 * Регистрация фабрики не создаёт политики полей и JSON-пример; вызов не использует БД или окружение.
 */
export type BatchHelpContractFactory = () => BatchHelpContractDefinition;

/**
 * Условные адрес и ревизия для построения оболочки примера по публичному descriptor.
 */
export interface BatchExampleContext {
  /* Адрес при обязательном ref; запрещён для операции без ref. */
  readonly ref?: string;
  /* Число из подготовленного сценария примера; по умолчанию 1, без чтения текущей БД. */
  readonly revision?: number;
}
