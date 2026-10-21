import type { EntityRecord } from "./index";
import type { TaskRecord } from "./tasks";

export type PlanningKind = "work-plan" | "release";
export const PLAN_STATUSES = ["draft", "active", "completed", "cancelled"] as const;
export const RELEASE_STATUSES = ["planned", "released", "cancelled"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];
export const PLAN_SCOPE_KINDS = [
  "project",
  "product",
  "application",
  "feature",
  "scenario",
  "implementation",
] as const;
export type PlanScope = { kind: (typeof PLAN_SCOPE_KINDS)[number]; id: string };

export type PlanStage = {
  id: string;
  title: string;
  summary: string;
  outcome: string;
  completionConditions: string;
  taskIds: string[];
};

export type WorkPlanFields = {
  title: string;
  summary: string;
  goal: string;
  rationale: string;
  boundaries: string;
  expectedResult: string;
  participants: string[];
  scope: PlanScope[];
};
export type ReleaseFields = {
  title: string;
  version: string;
  summary: string;
  description: string;
  planIds: string[];
  plannedFor: string;
};
export type WorkPlanInput = Pick<WorkPlanFields, "title"> & Partial<WorkPlanFields>;
export type ReleaseInput = Pick<ReleaseFields, "title" | "version" | "planIds"> &
  Partial<ReleaseFields>;
export type StageFields = Pick<PlanStage, "title" | "summary" | "outcome" | "completionConditions">;
export type StageChange =
  | { action: "create"; fields: StageFields; before: string | null }
  | { action: "update"; stageId: string; fields: Partial<StageFields> }
  | { action: "remove"; stageId: string }
  | {
      action: "move";
      stageId: string;
      destination: { before: string | null } | { direction: "up" | "down" };
    };
export type PlanTransition =
  { action: "start" } | { action: "complete" | "cancel"; result: string };
export type ReleaseTransition = "plan" | "cancel" | "publish";
export type PlanTaskTransfer = {
  task: string;
  targetPlan: string;
  targetStage: string;
  reason: string;
};

export type WorkPlanData = WorkPlanFields & {
  projectId: string;
  stages: PlanStage[];
  result: string;
  status: PlanStatus;
  startedAt: string | null;
  closedAt: string | null;
};
export type ReleaseData = ReleaseFields & {
  projectId: string;
  status: ReleaseStatus;
  releasedAt: string | null;
  releasedBy: string | null;
};
export type WorkPlanRecord = Omit<EntityRecord, "kind" | "data"> & {
  kind: "work-plan";
  data: WorkPlanData;
};
export type ReleaseRecord = Omit<EntityRecord, "kind" | "data"> & {
  kind: "release";
  data: ReleaseData;
};
export type PlanningRecord = WorkPlanRecord | ReleaseRecord;

export type PlanningFilter = { q?: string; status?: PlanStatus | ReleaseStatus };
/** Ревизия принадлежит плану, включая все его этапы и включения задач. */
export type PlanOwner = { plan: string; revision: number };
export type PlanStages = PlanOwner & { items: PlanStage[] };
export type PlanStageResult = PlanOwner & { stage: PlanStage };
export type PlanStageTasks = PlanOwner & { items: TaskRecord[] };
export type TaskPlanMemberships = { task: string; items: PlanStageResult[] };
/** Ревизия относится к составу релиза; каждый вложенный план имеет свою ревизию. */
export type ReleasePlans = { release: string; revision: number; items: WorkPlanRecord[] };
export type PlanTransferResult = { source: WorkPlanRecord; target: WorkPlanRecord };

export type ProgressCounts = { total: number; completed: number; percent: number };
export type PlanProgress = {
  completed: boolean;
  canComplete: boolean;
  blockers: string[];
  counts: ProgressCounts;
  stages: Array<{ id: string; completed: boolean; counts: ProgressCounts; blockers: string[] }>;
};
export type ReleaseProgress = {
  completed: boolean;
  canRelease: boolean;
  blockers: string[];
  counts: ProgressCounts;
  plans: Array<{ id: string; status: PlanStatus; completed: boolean; blockers: string[] }>;
};
