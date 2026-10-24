import type { CommandEffect, KnowledgeRecord, TaskRecord } from "@relay/contracts";
import type { CommandEntityAllocation } from "../commands/command-context.types";
import type { StoredTask, TaskTarget } from "./task-data.types";

/**
 * Проверенные выбранные цели и их доска, без возможности ленивого чтения.
 */
export interface TaskTargetContext {
  /* Доска назначения задачи. */
  readonly board: KnowledgeRecord<"board">;
  /* Разрешённые цели в исходном порядке, включая повторы для предметной проверки. */
  readonly targets: readonly TaskTarget[];
}

/**
 * Полный узкий материал создания одной задачи, выбранный явным loader.
 */
export interface TaskCreateContext extends TaskTargetContext {
  /* Разрешённый родитель; null означает корневую задачу. */
  readonly parent: TaskRecord | null;
  /* Полные декодированные карточки явно указанных зависимостей. */
  readonly dependencies: readonly TaskRecord[];
  /* Полные декодированные карточки явно указанных информационных связей. */
  readonly related: readonly TaskRecord[];
  /* Узкая проекция графа с предыдущими эффектами batch. */
  readonly graphRecords: readonly StoredTask[];
}

/**
 * Заранее выделенные значения создания; чистый расчёт ничего не генерирует.
 */
export interface TaskCreateAllocation extends CommandEntityAllocation {
  /* Свободный ключ выбранной доски, защищённый counter/address guard. */
  readonly key: string;
  /* Новые ID критериев по порядку проверенного ввода. */
  readonly criterionIds: readonly string[];
}

/**
 * Результат загрузки создания до единственного вызова calculator.
 */
export interface TaskCreatePreparation {
  /* Выбранный и декодированный материал. */
  readonly context: TaskCreateContext;
  /* Идентичность, ключ и стабильные метаданные будущих записей. */
  readonly allocation: TaskCreateAllocation;
}

/**
 * Материал переноса, включая выделенный ключ только при смене доски.
 */
export interface TaskMoveContext extends TaskTargetContext {
  /* Граф исходного overlay, ещё без текущего кандидата. */
  readonly graphRecords: readonly StoredTask[];
  /* Новый свободный ключ либо прежний ключ при сохранении доски. */
  readonly key: string;
}

/**
 * Материал изменения родительской связи.
 */
export interface TaskParentContext {
  /* Новый декодированный родитель либо null для снятия связи. */
  readonly parent: TaskRecord | null;
  /* Граф исходного overlay. */
  readonly graphRecords: readonly StoredTask[];
}

/**
 * Материал изменения зависимости либо информационной связи.
 */
export interface TaskLinkContext {
  /* Декодированная цель связи, включая удаление отсутствующей связи. */
  readonly target: TaskRecord;
  /* Граф исходного overlay, проверяемый также для информационных связей. */
  readonly graphRecords: readonly StoredTask[];
}

/**
 * Точный результат расчёта: содержание для результата и эффекты для единственного commit.
 */
export interface TaskCommandDelta {
  /* Проверенная карточка кандидата; итоговый журнал добавляет общий result finalizer. */
  readonly record: TaskRecord;
  /* Упорядоченные точные эффекты; no-op возвращает пустой массив. */
  readonly effects: readonly CommandEffect[];
}

/**
 * Вложенный результат критерия либо комментария с заранее известным постоянным ID.
 */
export interface TaskNestedDelta extends TaskCommandDelta {
  /* ID изменяемого вложенного элемента; удаление также возвращает прежний ID. */
  readonly id: string;
}
