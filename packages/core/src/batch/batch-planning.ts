import { PLAN_SCOPE_KINDS, type PlanningKind } from "@relay/contracts";
import { planFields, releaseFields, stageFields } from "../planning/planning.constants";
import { decodePlan, decodePlanning } from "../planning/planning-data";
import { assertPlanningWritable } from "../planning/planning-rules";
import {
  parsePlanTransition,
  parseReleaseTransition,
  parseStageChange,
  parseTransfer,
} from "../planning/planning-input";
import {
  allocatePlanningCreation,
  loadPlanningFields,
  loadPlanningGraph,
  loadPlanningMembership,
  loadReleasePlans,
} from "../planning/planning-command-load";
import {
  calculatePlanningCreation,
  calculatePlanningUpdate,
} from "../planning/planning-command-calculate";
import {
  calculatePlanTransition,
  calculateReleaseTransition,
} from "../planning/planning-command-lifecycle";
import {
  calculatePlanningStage,
  calculatePlanningMembership,
  calculatePlanningTransfer,
} from "../planning/planning-command-membership";
import { batchAction } from "./batch-action";
import { batchIdentity, type BatchStepContext } from "./batch-context";
import { batchMessages } from "./batch.messages";
import type { BatchAction, BatchAddressField, BatchOutcome } from "./batch.types";

const stageInputFields = {
  create: [...stageFields, "before"],
  update: ["stageId", ...stageFields],
  move: ["stageId", "before", "direction"],
  remove: ["stageId"],
} as const;

/**
 * Загружает владельца и основания перехода, затем один раз рассчитывает точный эффект.
 * Переходы готовности используют общий taskGraphCache выбранного состояния overlay.
 */
async function transitionPlanning(
  context: BatchStepContext,
  kind: PlanningKind,
  action: string,
): Promise<BatchOutcome> {
  const current = decodePlanning(
    await context.commands.get(await context.ref(kind), kind),
    context.commands.projectId,
  );
  const write = context.write(current);
  assertPlanningWritable(current, write);
  if (current.kind === "work-plan") {
    const change = parsePlanTransition(action, context.input);
    const graph =
      change.action === "complete" ? await loadPlanningGraph(context.commands, [current]) : [];
    const delta = calculatePlanTransition(
      current,
      change,
      graph,
      context.commands.taskGraphCache,
      write,
      context.commands.timestamp,
    );
    context.commands.apply(delta.effects);
    return context.result(delta.record);
  }
  const change = parseReleaseTransition(action, context.input);
  const plans =
    (change === "publish" && current.data.status === "planned") ||
    (change === "plan" && current.data.status === "cancelled")
      ? await loadReleasePlans(context.commands, current.data.planIds)
      : [];
  const graph = change === "publish" ? await loadPlanningGraph(context.commands, plans) : [];
  const delta = calculateReleaseTransition(
    current,
    change,
    plans,
    graph,
    context.commands.taskGraphCache,
    write,
    context.commands.timestamp,
  );
  context.commands.apply(delta.effects);
  return context.result(delta.record);
}

/**
 * Загружает обе стороны переноса, задачу и все её включения. Исходные CAS и переносимые
 * токены проверяются независимо для каждой стороны, в том числе при совпадении ID.
 */
async function transferPlanning(context: BatchStepContext): Promise<BatchOutcome> {
  const {
    targetRevision: _targetRevision,
    targetVersion: _targetVersion,
    ...input
  } = context.input;
  const fields = parseTransfer(input);
  const source = decodePlan(
    await context.commands.get(await context.ref("work-plan"), "work-plan"),
    context.commands.projectId,
  );
  const target = decodePlan(
    await context.commands.get(fields.targetPlan, "work-plan"),
    context.commands.projectId,
  );
  const write = context.write(source);
  const targetWrite = context.writeRevision(
    target,
    context.input.targetRevision,
    "input.targetRevision",
    context.input.targetVersion,
  );
  assertPlanningWritable(source, write);
  assertPlanningWritable(target, targetWrite);
  const membership = await loadPlanningMembership(context.commands, fields.task, true);
  const delta = calculatePlanningTransfer(
    { ...membership, source, target, input: fields },
    { ...write, targetRevision: targetWrite.ifRevision },
    context.commands.timestamp,
  );
  context.commands.apply(delta.effects);
  context.touch(delta.target);
  return context.result(delta.source, delta.source, [
    { name: "target", ...batchIdentity(delta.target) },
  ]);
}

/**
 * Единственные async обработчики планирования: explicit load → pure calculate → sparse effects.
 * Сохранение и проверка исходных guards выполняются общим executor после всех шагов.
 */
export function planningBatchActions(): BatchAction<BatchStepContext>[] {
  const actions: BatchAction<BatchStepContext>[] = [];
  for (const kind of ["work-plan", "release"] as const) {
    const command = kind === "work-plan" ? "plan" : "release";
    const fields = kind === "work-plan" ? planFields : releaseFields;
    const addresses: readonly BatchAddressField[] =
      kind === "work-plan"
        ? [{ path: "scope.*.id", kinds: PLAN_SCOPE_KINDS }]
        : [{ path: "planIds.*", kinds: ["work-plan"] }];
    actions.push(
      batchAction(
        `${command}.create`,
        fields,
        { description: batchMessages.descriptions.planning, addresses },
        async (context) => {
          const loaded = await loadPlanningFields(context.commands, kind, context.input);
          const allocation = await allocatePlanningCreation(context.commands, kind);
          const delta = calculatePlanningCreation(loaded, allocation);
          context.commands.apply(delta.effects);
          context.created(delta.record);
          return context.result(delta.record);
        },
      ),
    );
    actions.push(
      batchAction(
        `${command}.update`,
        fields,
        {
          description: batchMessages.descriptions.planning,
          ref: true,
          revisionOwner: kind,
          addresses,
        },
        async (context) => {
          const current = decodePlanning(
            await context.commands.get(await context.ref(kind), kind),
            context.commands.projectId,
          );
          const write = context.write(current);
          assertPlanningWritable(current, write);
          const loaded = await loadPlanningFields(context.commands, kind, context.input);
          const delta = calculatePlanningUpdate(current, loaded, write, context.commands.timestamp);
          context.commands.apply(delta.effects);
          return context.result(delta.record);
        },
      ),
    );
    const transitions =
      kind === "work-plan" ? ["start", "complete", "cancel"] : ["plan", "publish", "cancel"];
    for (const action of transitions) {
      actions.push(
        batchAction(
          `${command}.${action}`,
          kind === "work-plan" && action !== "start" ? ["result"] : [],
          {
            description: batchMessages.descriptions.planning,
            ref: true,
            revisionOwner: kind,
          },
          (context) => transitionPlanning(context, kind, action),
        ),
      );
    }
  }
  for (const action of ["create", "update", "move", "remove"] as const) {
    actions.push(
      batchAction(
        `plan.stage.${action}`,
        stageInputFields[action],
        {
          description: batchMessages.descriptions.stage,
          ref: true,
          revisionOwner: "work-plan",
          addresses: [
            { path: "stageId", kinds: ["plan-stage"] },
            { path: "before", kinds: ["plan-stage"] },
          ],
        },
        async (context) => {
          const current = decodePlan(
            await context.commands.get(await context.ref("work-plan"), "work-plan"),
            context.commands.projectId,
          );
          const write = context.write(current);
          assertPlanningWritable(current, write);
          const change = parseStageChange(action, context.input);
          const id = change.action === "create" ? context.commands.allocateId() : change.stageId;
          const delta = calculatePlanningStage(
            current,
            change,
            change.action === "create" ? id : null,
            write,
            context.commands.timestamp,
          );
          context.commands.apply(delta.effects);
          return context.nested(id, "plan-stage", delta.record);
        },
      ),
    );
  }
  for (const remove of [false, true]) {
    actions.push(
      batchAction(
        `plan.stage.task.${remove ? "remove" : "add"}`,
        ["stageId", "task"],
        {
          description: batchMessages.descriptions.stage,
          ref: true,
          revisionOwner: "work-plan",
          addresses: [
            { path: "stageId", kinds: ["plan-stage"] },
            { path: "task", kinds: ["task"] },
          ],
        },
        async (context) => {
          const current = decodePlan(
            await context.commands.get(await context.ref("work-plan"), "work-plan"),
            context.commands.projectId,
          );
          const write = context.write(current);
          assertPlanningWritable(current, write);
          const loaded = await loadPlanningMembership(
            context.commands,
            context.text("task"),
            !remove,
          );
          const delta = calculatePlanningMembership(
            current,
            context.text("stageId"),
            remove,
            loaded,
            write,
            context.commands.timestamp,
          );
          context.commands.apply(delta.effects);
          return context.nested(context.text("stageId"), "plan-stage", delta.record);
        },
      ),
    );
  }
  actions.push(
    batchAction(
      "plan.stage.task.transfer",
      ["task", "targetPlan", "targetStage", "reason", "targetRevision", "targetVersion"],
      {
        description: batchMessages.descriptions.transfer,
        ref: true,
        revisionOwner: "work-plan",
        addresses: [
          { path: "task", kinds: ["task"] },
          { path: "targetPlan", kinds: ["work-plan"] },
          { path: "targetStage", kinds: ["plan-stage"] },
        ],
      },
      transferPlanning,
    ),
  );
  return actions;
}
