import type {
  CommandEffect,
  EntityIdentity,
  EntityRecord,
  PlanningRecord,
  PlanTaskTransfer,
  ReleaseFields,
  WorkPlanFields,
  WorkPlanRecord,
  WriteOptions,
} from "@relay/contracts";
import type { CommandEntityAllocation } from "../commands/command-context.types";

/**
 * Проверенные условия чистого переноса после проверки клиентских версий в command context.
 * Числовые ревизии обязательны; public version-only API не ослабляет этот контракт.
 */
export interface CheckedPlanTransferWriteOptions extends Readonly<WriteOptions> {
  /* Проверенная локальная ревизия целевого владельца из того же guarded snapshot. */
  readonly targetRevision: number;
}

/**
 * Поля планирования и только явно выбранные для них цели одного anchor.
 */
export type PlanningFieldsContext =
  | {
      /* Вид создаваемого или изменяемого владельца. */
      readonly kind: "work-plan";
      /* Проверенные поля с ещё не раскрытыми объектными ссылками scope. */
      readonly fields: Readonly<Partial<WorkPlanFields>>;
      /* Разрешённые цели в порядке scope; пусто при отсутствии поля. */
      readonly scope: readonly EntityIdentity[];
    }
  | {
      /* Вид создаваемого или изменяемого владельца. */
      readonly kind: "release";
      /* Проверенные поля с исходным порядком состава. */
      readonly fields: Readonly<Partial<ReleaseFields>>;
      /* Декодированные планы в порядке переданных ссылок, включая повторы алиасов. */
      readonly plans: readonly WorkPlanRecord[];
    };

/**
 * Все метаданные создания выделены до чистого расчёта.
 */
export interface PlanningCreationAllocation extends CommandEntityAllocation {
  /* Свободный предварительный ключ, защищённый allocator guard. */
  readonly key: string;
  /* Постоянный ID выбранного проекта. */
  readonly projectId: string;
}

/**
 * Точный результат чистого изменения одного владельца, включая пустой эффект no-op.
 */
export interface PlanningDelta<T extends PlanningRecord = PlanningRecord> {
  /* Полное состояние владельца непосредственно после этого шага. */
  readonly record: T;
  /* Упорядоченные before/after для sparse overlay и guarded commit. */
  readonly effects: readonly CommandEffect[];
}

/**
 * Выбранная задача и полное множество её включений; пустота защищена selector guard.
 */
export interface PlanningMembershipContext {
  /* Полная сохранённая задача для проверки повреждённого содержания. */
  readonly task: EntityRecord;
  /* Все относящиеся к задаче планы, включая закрытые; остальные планы не читаются. */
  readonly memberships: readonly WorkPlanRecord[];
}

/**
 * Обе стороны переноса и исходный явный запрос без обращений к хранилищу.
 */
export interface PlanningTransferContext extends PlanningMembershipContext {
  /* Исходный владелец и его этапы. */
  readonly source: WorkPlanRecord;
  /* Целевой владелец; может совпадать с исходным. */
  readonly target: WorkPlanRecord;
  /* Проверенные адреса и обязательное обоснование. */
  readonly input: PlanTaskTransfer;
}

/**
 * Точный результат переноса; у одного владельца в effects только одна запись.
 */
export interface PlanningTransferDelta {
  /* Исходный план после исключения включения. */
  readonly source: WorkPlanRecord;
  /* Целевой план после включения задачи. */
  readonly target: WorkPlanRecord;
  /* Упорядоченные изменения обоих владельцев, атомарные при commit. */
  readonly effects: readonly CommandEffect[];
}
