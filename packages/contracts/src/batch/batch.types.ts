import type { EntityKind } from "../entities/identity.types";
import type { ProjectEntity } from "../project-entity.types";
import type { BATCH_NESTED_RESULT_KINDS } from "./batch.constants";

/**
 * Ссылка на основной ID ранее выполненного шага, доступная только в адресных полях.
 */
export interface BatchReference {
  /* Уникальное локальное имя as предыдущего шага; имена вперёд запрещены. */
  readonly $ref: string;
}

/**
 * Ревизия владельца предыдущего результата; владелец должен совпадать с изменяемым.
 */
export interface BatchRevisionReference {
  /* Локальное имя шага, вернувшего ревизию нужного владельца. */
  readonly $revision: string;
}

/**
 * Виды основных и вложенных результатов предметных действий пакета.
 */
export type BatchResultKind = EntityKind | (typeof BATCH_NESTED_RESULT_KINDS)[number];

/**
 * Компактная идентичность результата без пользовательского содержания.
 */
export interface BatchIdentity {
  /* Постоянный ID сущности либо вложенного объекта. */
  readonly id: string;
  /* Предметный вид результата; вложенные объекты имеют отдельные виды. */
  readonly kind: BatchResultKind;
  /* Ключ сущности; null у вложенного объекта без самостоятельного ключа. */
  readonly key: string | null;
  /* Ревизия сущности либо владельца вложенного объекта на момент шага. */
  readonly revision: number;
}

/**
 * Владелец CAS результата, используемый при разрешении $revision.
 */
export interface BatchRevisionOwner extends BatchIdentity {
  /* Вид самостоятельной сущности, чья ревизия защищает действие. */
  readonly kind: EntityKind;
  /* Текущий ключ владельца на момент шага. */
  readonly key: string;
}

/**
 * Именованный дополнительный выход: доска, участие, критерий или второй план переноса.
 */
export interface BatchOutput extends BatchIdentity {
  /* Имя поля выхода; несколько критериев или реализаций имеют одинаковое имя. */
  readonly name: string;
}

/**
 * Квитанция одного успешно выполненного шага внутри целиком успешного пакета.
 */
export interface BatchItemResult extends BatchIdentity {
  /* Индекс операции во входном массиве, начиная с нуля. */
  readonly index: number;
  /* Имя предметного действия из опубликованного каталога BATCH_OPERATIONS. */
  readonly op: string;
  /* Локальное имя результата; null, если as отсутствовало. */
  readonly as: string | null;
  /* Ревизия правильного владельца сразу после этого шага. */
  readonly owner: BatchRevisionOwner;
  /* Дополнительные компактные выходы в предметном порядке; пусто при их отсутствии. */
  readonly outputs: readonly BatchOutput[];
}

/**
 * Первоначальный результат атомарного применения либо полностью откатившейся проверки.
 * entities содержит итоговые записи, а items — идентичности на момент каждого шага.
 */
export interface BatchResult {
  /* Ключ квитанции; null при проверке без ключа. */
  readonly operationKey: string | null;
  /* committed — сохранено; checked — выполнено с принудительным откатом. */
  readonly status: "committed" | "checked";
  /* true при восстановлении первоначальной квитанции, включая getResult. */
  readonly replayed: boolean;
  /* Квитанции в порядке операций входа. */
  readonly items: readonly BatchItemResult[];
  /* Полные итоговые затронутые записи, включая зависимые; ID уникальны, порядок первого касания. */
  readonly entities: readonly ProjectEntity[];
}

/**
 * Параметры применения, независимые от представления результата вызывающим интерфейсом.
 */
export interface BatchOptions {
  /* Общий автор всех предметных действий; сохраняется дословно. */
  readonly actor: string;
  /* Уникальный в проекте ключ; обязателен при применении и не расходуется проверкой. */
  readonly operationKey?: string;
  /* true выполняет тот же сценарий с откатом без записи квитанции. */
  readonly check?: boolean;
}

/**
 * Публичное описание входа действия; значения полей проверяет предметный сервис Core.
 */
export interface BatchOperationDescription {
  /* Имя операции, совпадающее с предметными словами CLI через точку. */
  readonly op: string;
  /* Краткое русское описание ответственности и владельца CAS. */
  readonly description: string;
  /* Требование к верхнеуровневому ref; singleton не принимает ref. */
  readonly ref: "required" | "none";
  /* Владелец обязательного ifRevision либо expectedVersion; null у создания и независимого комментария. */
  readonly revisionOwner: string | null;
  /* Единственные допустимые поля input; обязательность и значения определяет предметный ввод. */
  readonly inputFields: readonly string[];
  /* Адресные пути input, принимающие $ref; * обозначает элемент массива. */
  readonly referenceFields: readonly string[];
}

/**
 * Координаты отказа пакета, добавляемые к details исходной предметной ошибки.
 */
export interface BatchErrorLocation {
  /* Индекс неуспешной операции, начиная с нуля. */
  readonly index: number;
  /* Исходное имя действия. */
  readonly op: string;
  /* Путь относительно запроса, например operations[2].input.target. */
  readonly path: string;
}
