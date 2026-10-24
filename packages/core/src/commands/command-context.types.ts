import type {
  CommandCounter,
  CommandEffect,
  CommandGuard,
  CommandReadPredicate,
  EntityRecord,
} from "@relay/contracts";

/**
 * Совместимость прежнего точечного фасада при нормализации в общий каталог команд.
 */
export interface CommandExecutorCompatibility {
  /* Только внутренние фасады сохраняют conditional-create и прежнюю форму singleton/accepted IDs. */
  readonly legacyFacade?: boolean;
}

/**
 * Состояние исключительно текущего предметного шага, фиксируемое до следующего loader.
 */
export interface CommandStepTrace {
  /* Номер операции исходного batch. */
  readonly index: number;
  /* Имя действия единственного каталога. */
  readonly operation: string;
  /* Полные карточки, реально использованные в состоянии этого шага. */
  readonly reads: Map<string, EntityRecord>;
  /* Исходные guards загруженных частей БД. */
  readonly guards: Map<string, CommandGuard>;
  /* Точные наблюдения с предыдущими эффектами overlay. */
  readonly predicates: CommandReadPredicate[];
  /* Рассчитанные эффекты в порядке применения. */
  readonly effects: CommandEffect[];
  /* Постоянные ID всех проверенных владельцев этого шага. */
  readonly owners: Set<string>;
  /* Разрешённые адресные роли без строковых aliases запроса. */
  readonly targets: Map<string, string | null>;
}

/**
 * Независимые метаданные чистого создания записи.
 */
export interface CommandEntityAllocation {
  /* Заранее выделенный постоянный ID. */
  readonly id: string;
  /* Проверенный автор. */
  readonly actor: string;
  /* Уже зафиксированное время подготовки. */
  readonly timestamp: string;
}

/**
 * Технический cursor префикса только внутри одного пакета.
 */
export interface CommandKeyCursor extends CommandCounter {
  /* Последнее выбранное значение, изменяемое только оркестратором выделения ключей. */
  after: number;
}
