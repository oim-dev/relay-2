import type { PlanStage, ReleaseRecord, WorkPlanRecord } from "@relay/contracts";

/**
 * Снимок владельца редактора; версия не обновляется после начала пользовательского ввода.
 */
export interface PlanningSource<
  T extends WorkPlanRecord | ReleaseRecord = WorkPlanRecord | ReleaseRecord,
> {
  /* Полная прочитанная карточка владельца CAS, включая этапы или состав. */
  readonly entity: T;
  /* Прочитанный переносимый токен того же снимка; отсутствие допускает локальный CAS. */
  readonly expectedVersion?: string;
}

/**
 * Снимок редактируемого этапа вместе с планом-владельцем его ревизии.
 */
export interface StageSource extends PlanningSource<WorkPlanRecord> {
  /* Этап из исходного плана; отсутствие означает создание. */
  readonly stage?: PlanStage;
}

/**
 * Исходный этап для изменения membership; он уже принадлежит прочитанному плану.
 */
export interface PlanMembershipSource extends PlanningSource<WorkPlanRecord> {
  /* Этап из того же исходного снимка плана, не создаваемый новой командой. */
  readonly stage: PlanStage;
}

/**
 * Намерение изменить включение задачи; перенос хранит отдельный исходный снимок назначения.
 */
export type PlanMembershipChange =
  | {
      /* Добавление или снятие включения в исходном этапе. */
      readonly action: "add" | "remove";
      /* Постоянный ID выбранной задачи. */
      readonly task: string;
    }
  | {
      /* Атомарный перенос между этапами исходного плана и плана назначения. */
      readonly action: "transfer";
      /* Постоянный ID переносимой задачи. */
      readonly task: string;
      /* Исходный снимок назначения; его guards не заменяются после выбора. */
      readonly target: PlanningSource<WorkPlanRecord>;
      /* Постоянный ID выбранного этапа назначения. */
      readonly targetStage: string;
      /* Непустое обоснование явного переноса. */
      readonly reason: string;
    };
