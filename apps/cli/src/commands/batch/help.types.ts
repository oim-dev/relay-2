import type { BatchOperationDescription, StageChange } from "@relay/contracts";
import type { BatchFieldContract } from "./help-contract.types";

/**
 * Поле canonical JSON пакета с форматом и назначением для автономной справки.
 */
export interface BatchFieldHelp {
  /* Имя поля input из предметного каталога, без CLI-алиасов и файловых источников. */
  readonly name: string;
  /* JSON-тип или точная форма; не выводится из русскоязычного описания либо parser-функции. */
  readonly format: string;
  /* Назначение из схемы владельца либо пояснение отличающейся формы batch. */
  readonly description: string;
  /* Единый предметный policy справки: обязательность, пропуск и допустимость null. */
  readonly contract: BatchFieldContract;
}

/**
 * Публичное описание действия, дополненное только сведениями для представления CLI.
 */
export interface BatchOperationHelp {
  /* Неизменённый предметный контракт, включая порядок полей и пути локальных ссылок. */
  readonly operation: BatchOperationDescription;
  /* Конкретное назначение из зарегистрированной команды, например «Создать этап». */
  readonly title: string;
  /* Поля input в исходном порядке каталога; пустой массив означает input: {}. */
  readonly fields: readonly BatchFieldHelp[];
  /* Назначение ref из предметной команды; null, если действие не принимает ref. */
  readonly referenceDescription: string | null;
}

/**
 * Допустимые направления перестановки из переносимого контракта; CLI-флага для них нет.
 */
export type BatchStageDirection = Extract<
  Extract<StageChange, { action: "move" }>["destination"],
  { direction: unknown }
>["direction"];
