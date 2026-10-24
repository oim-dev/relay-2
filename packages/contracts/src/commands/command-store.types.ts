import type { EntityIdentity, EntityRecord } from "../entities/entity.types";
import type { EntityKind } from "../entities/identity.types";
import type { TaskComment } from "../tasks/tasks.types";
import type { BatchResult } from "../batch/batch.types";
import type { ProjectEntity } from "../project-entity.types";
import type { EntityReadResult } from "../queries/entity-read.types";

/**
 * Локальный согласованный контекст нескольких асинхронных загрузок команды.
 */
export interface CommandReadAnchor {
  /* Постоянный ID выбранной физической реплики. */
  readonly replicaId: string;
  /* Монотонная версия всех наблюдаемых командой данных, включая адреса и counters. */
  readonly revision: number;
}

/**
 * Конечные логические выборки команд; SQL и предметная допустимость сюда не входят.
 */
export type CommandSelector =
  | {
      readonly kind: "entity";
      readonly ref: string;
      readonly entityKind?: EntityKind;
      readonly semantic?: "content" | "existence";
    }
  | { readonly kind: "identities"; readonly refs: readonly string[] }
  | { readonly kind: "records"; readonly ids: readonly string[]; readonly entityKind?: EntityKind }
  | { readonly kind: "summaries"; readonly ids: readonly string[] }
  | { readonly kind: "virtual"; readonly ref: string; readonly entityKind: EntityKind }
  | {
      readonly kind: "field";
      readonly entityKind: EntityKind;
      readonly field: string;
      readonly value: string;
    }
  | {
      readonly kind: "field-set";
      readonly entityKind: EntityKind;
      readonly field: string;
      readonly values: readonly string[];
    }
  | { readonly kind: "kind"; readonly entityKind: EntityKind }
  | {
      readonly kind: "array-item";
      readonly entityKind: EntityKind;
      readonly arrayField: string;
      readonly itemField: string;
      readonly value: string;
    }
  | { readonly kind: "task-graph" }
  | { readonly kind: "memberships"; readonly taskId: string }
  | {
      readonly kind: "key";
      readonly entityKind: EntityKind;
      readonly prefix: string;
      readonly after: number;
      readonly excluded: readonly string[];
    }
  | { readonly kind: "address-state"; readonly ref: string }
  | { readonly kind: "receipt"; readonly operationKey: string };

/**
 * Первоначальная квитанция, прочитанная без текущих сущностей.
 */
export interface CommandReceipt {
  /* Проектный неизменяемый ключ идемпотентности. */
  readonly operationKey: string;
  /* Канонический запрос вместе с автором. */
  readonly requestJson: string;
  /* Первоначальный полный результат. */
  readonly resultJson: string;
}

/**
 * Переносимые версии загруженного владельца, отдельные от локального CAS и data.
 */
export interface CommandEntityVersions {
  /* Версия первичной записи без нормализованных частей и локальной revision. */
  readonly recordVersion: string;
  /* Непрозрачный токен первичной версии и полного состава версий частей; журнал комментариев исключён. */
  readonly aggregateVersion: string;
}

/**
 * Проверенный сохраняемый агрегат и его версии из одного согласованного чтения.
 * Снятые исторические ссылки не заменяются UI-проекциями; вычисляемая готовность сюда не входит.
 */
export interface VersionedCommandEntity {
  /* Декодированный сохраняемый агрегат; task.comments — независимый журнал того же снимка. */
  readonly entity: ProjectEntity;
  /* recordVersion не заменяет aggregateVersion в условии изменения владельца. */
  readonly versions: CommandEntityVersions;
}

/**
 * Узкая сырая проекция summary без содержимого, составов и комментариев.
 */
export interface CommandEntitySummaryProjection extends Readonly<EntityIdentity> {
  /* Локальная revision владельца из того же снимка. */
  readonly revision: number;
  /* Сохранённое title/name; undefined обозначает отсутствие поля, null остаётся явным null. */
  readonly title: unknown;
  /* Сохранённый статус применимого вида либо undefined. */
  readonly state: unknown;
  /* Признак active реализации либо undefined. */
  readonly active: unknown;
}

/**
 * Прежнее projected getMany и отдельная metadata версий того же снимка.
 */
export interface VersionedEntityReadResult {
  /* Исходный full/summary результат, порядок, повторы, ошибки и generation сохранены. */
  readonly data: EntityReadResult;
  /* Только успешно прочитанные IDs; повторы одного ID имеют общий token. */
  readonly versions: Readonly<Record<string, CommandEntityVersions>>;
}

/**
 * Результат выбранной логической проекции одного снимка.
 */
export type CommandObservation =
  | {
      readonly kind: "records";
      readonly records: readonly EntityRecord[];
      /* Версии полных записей; отсутствуют только у узкой графовой проекции. */
      readonly versions?: Readonly<Record<string, CommandEntityVersions>>;
    }
  | {
      readonly kind: "summaries";
      readonly summaries: readonly (CommandEntitySummaryProjection | null)[];
      readonly versions: Readonly<Record<string, CommandEntityVersions>>;
    }
  | { readonly kind: "identities"; readonly identities: readonly (EntityIdentity | null)[] }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "key"; readonly key: string; readonly before: number; readonly value: number }
  | {
      readonly kind: "address-state";
      readonly currentId: string | null;
      readonly previousId: string | null;
    }
  | { readonly kind: "receipt"; readonly receipt: CommandReceipt | null };

/**
 * Проверяемая исходная выборка; пустой результат защищает отрицательный предикат.
 */
export interface CommandGuard {
  /* Точная логическая выборка до наложения собственных эффектов. */
  readonly selector: CommandSelector;
  /* Отпечаток версий/состава; независимые комментарии не включаются в content guard. */
  readonly fingerprint: string;
}

/**
 * Точный прочитанный предикат предметного шага, включая известное отсутствие.
 * Наблюдение включает эффекты предыдущих шагов, а не только исходную SQL-выборку.
 */
export interface CommandReadPredicate {
  /* Логическая область прочитанного положительного либо отрицательного факта. */
  readonly selector: CommandSelector;
  /* Согласованное наблюдение, переданное чистому предметному расчёту. */
  readonly observation: CommandObservation;
}

/**
 * Один async запрос материала; переданный anchor не допускает смешения загрузок.
 */
export interface CommandLoadRequest {
  /* null открывает логический контекст; следующие запросы сохраняют возвращённый anchor. */
  readonly anchor: CommandReadAnchor | null;
  /* Независимые логические выборки в порядке ожидаемых результатов. */
  readonly selectors: readonly CommandSelector[];
}

/**
 * Согласованные сырые данные и исходные guards, без предметного декодирования.
 */
export interface CommandLoadResult {
  /* Идентичность согласованного состояния. */
  readonly anchor: CommandReadAnchor;
  /* Поколение предметных данных того же снимка; отличается от технической revision anchor. */
  readonly generation: number;
  /* Результат для каждого selector в исходном порядке. */
  readonly observations: readonly CommandObservation[];
  /* Проверки тех же исходных выборок для atomic commit. */
  readonly guards: readonly CommandGuard[];
}

/**
 * Уже рассчитанный точный эффект; последовательность сохраняет промежуточные ревизии.
 */
export type CommandEffect =
  | { readonly kind: "entity"; readonly before: EntityRecord | null; readonly after: EntityRecord }
  | { readonly kind: "comment"; readonly taskId: string; readonly comment: TaskComment };

/**
 * Разрешённая цель и роли перехода; не зависят от порядка чтений и сохраняются для no-op.
 */
export interface CommandTransitionTargets {
  /* Постоянный ID основной самостоятельной или вложенной цели; null только у технического boundary. */
  readonly primaryId: string | null;
  /* Постоянные ID владельцев проверяемого состояния, включая обе стороны transfer. */
  readonly ownerIds: readonly string[];
  /* Разрешённые ID адресных ролей каталога и именованных outputs; null обозначает явное снятие. */
  readonly roles: Readonly<Record<string, string | null>>;
}

/**
 * Один предметный переход ordered tape; не инструкция повторно исполнить команду.
 */
export interface CommandTransition {
  /* Номер исходного шага; не меняется при переносе эффекта. */
  readonly index: number;
  /* Предметное имя перехода из единственного каталога. */
  readonly operation: string;
  /* Дословно проверенный автор перехода. */
  readonly actor: string;
  /* Зафиксированное время подготовки, не арбитр конкуренции. */
  readonly timestamp: string;
  /* Явные цели и владельцы проверки, даже если effects пуст. */
  readonly targets: CommandTransitionTargets;
  /* Согласованные факты, использованные чистым расчётом этого шага. */
  readonly reads: readonly EntityRecord[];
  /* Исходные положительные и отрицательные выборки этого шага. */
  readonly guards: readonly CommandGuard[];
  /* Точные предметные наблюдения, включая пустые составы и отсутствие закрытия/владельца. */
  readonly predicates: readonly CommandReadPredicate[];
  /* Точные последовательные эффекты шага. */
  readonly effects: readonly CommandEffect[];
}

/**
 * Точное изменение технического счётчика выделенных ключей.
 */
export interface CommandCounter {
  /* Префикс в области проекта. */
  readonly prefix: string;
  /* Исходное сохранённое значение, 0 обозначает отсутствие строки. */
  readonly before: number;
  /* Последний реально выбранный номер данного пакета. */
  readonly after: number;
}

/**
 * Только факты результата; callback не получает I/O и не выбирает новые записи.
 */
export interface CommandCommitFacts {
  /* Полные журналы исключительно объявленных задач после append-эффектов. */
  readonly comments: ReadonlyMap<string, readonly TaskComment[]>;
  /* Актуальные полные task-only карточки без собственного content-effect; чтение не создаёт content dependency. */
  readonly taskRecords: ReadonlyMap<string, EntityRecord>;
  /* Поколение данных того же commit-снимка. */
  readonly generation: number;
}

/**
 * План одного atomic commit; пользовательский CAS не заменяется прочитанной свежей ревизией.
 */
export interface CommandCommitPlan {
  /* Постоянный ID выбранного проекта. */
  readonly projectId: string;
  /* Физическая реплика подготовленного ReadAnchor; commit не принимает план другой реплики. */
  readonly replicaId: string;
  /* Дословно проверенный автор всех шагов. */
  readonly actor: string;
  /* Неизменное время подготовки, без повторного чтения часов внутри calculator. */
  readonly timestamp: string;
  /* check проходит SQL-путь с последующим откатом. */
  readonly check: boolean;
  /* Исходные положительные и отрицательные предикаты. */
  readonly guards: readonly CommandGuard[];
  /* Ordered tape с промежуточными состояниями, а не только net delta. */
  readonly transitions: readonly CommandTransition[];
  /* Технические counters, по одной записи на префикс. */
  readonly counters: readonly CommandCounter[];
  /* null отключает пользовательскую receipt; transport changeset сохраняется независимо. */
  readonly receipt: { readonly operationKey: string; readonly requestJson: string } | null;
  /* Задачи, журналы которых нужны в первоначальном результате. */
  readonly commentTaskIds: readonly string[];
  /* Только append-only владельцы без entity-effects: их актуальное содержание нужно первоначальному ответу. */
  readonly freshTaskIds: readonly string[];
  /* Чистая синхронная сборка первоначального результата из уже подготовленных карточек. */
  readonly finalize: (facts: CommandCommitFacts) => BatchResult;
}

/**
 * Исход записи: replay возвращает первоначальную квитанцию до новых guards.
 * Конкурентный отказ и инфраструктурная ошибка отклоняют Promise разными RelayError.code.
 */
export type CommandCommitResult =
  | { readonly kind: "committed" | "checked"; readonly result: BatchResult }
  | { readonly kind: "replayed"; readonly receipt: CommandReceipt };

/**
 * Настоящая async граница I/O; чистые calculators не получают этот объект.
 */
export interface CommandStore {
  /* Постоянный ID выбранного проекта. */
  readonly projectId: string;
  /**
   * Загружает ограниченный согласованный контекст либо отклоняет устаревший anchor.
   */
  load(request: CommandLoadRequest): Promise<CommandLoadResult>;
  /**
   * Проверяет guards, сохраняет все effects/receipt/outbox атомарно либо откатывает.
   */
  commit(plan: CommandCommitPlan): Promise<CommandCommitResult>;
}
