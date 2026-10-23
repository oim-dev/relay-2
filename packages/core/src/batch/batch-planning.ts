import { PLAN_SCOPE_KINDS } from "@relay/contracts";
import { planFields, releaseFields, stageFields } from "../planning/planning.constants";
import { batchAction } from "./batch-action";
import { batchIdentity, type BatchStepContext } from "./batch-context";
import { batchMessages } from "./batch.messages";
import type { BatchAction, BatchAddressField } from "./batch.types";

const stageInputFields = {
  create: [...stageFields, "before"],
  update: ["stageId", ...stageFields],
  move: ["stageId", "before", "direction"],
  remove: ["stageId"],
} as const;

/**
 * Объявляет предметные действия планирования; этапы адресуются только внутри своего плана.
 * Проверки составов и готовности остаются у PlanningService в том же состоянии транзакции.
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
        (context) => {
          const created = context.planning.create(kind, context.input, context.actor);
          context.created(created);
          return context.result(created);
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
        (context) => {
          const ref = context.ref(kind);
          return context.result(
            context.planning.update(
              kind,
              ref,
              context.input,
              context.write(context.planning.get(kind, ref)),
            ),
          );
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
          (context) => {
            const ref = context.ref(kind);
            return context.result(
              context.planning.transition(
                kind,
                ref,
                action,
                context.input,
                context.write(context.planning.get(kind, ref)),
              ),
            );
          },
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
        (context) => {
          const ref = context.ref("work-plan");
          const current = context.planning.get("work-plan", ref);
          const updated = context.planning.stage(
            ref,
            action,
            context.input,
            context.write(current),
          );
          const previous = new Set(current.data.stages.map((stage) => stage.id));
          const id =
            action === "create"
              ? updated.data.stages.find((stage) => !previous.has(stage.id))?.id
              : context.text("stageId");
          return context.nested(id, "plan-stage", updated);
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
        (context) => {
          const ref = context.ref("work-plan");
          const write = context.write(context.planning.get("work-plan", ref));
          const updated = context.planning.stageTask(
            ref,
            context.text("stageId"),
            context.text("task"),
            remove,
            write,
          );
          return context.nested(context.text("stageId"), "plan-stage", updated);
        },
      ),
    );
  }
  actions.push(
    batchAction(
      "plan.stage.task.transfer",
      ["task", "targetPlan", "targetStage", "reason", "targetRevision"],
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
      (context) => {
        const ref = context.ref("work-plan");
        const source = context.planning.get("work-plan", ref);
        const target = context.planning.get("work-plan", context.text("targetPlan"));
        const write = context.write(source);
        const targetWrite = context.writeRevision(
          target,
          context.input.targetRevision,
          "input.targetRevision",
        );
        const { targetRevision: _targetRevision, ...input } = context.input;
        const result = context.planning.transfer(ref, input, {
          ...write,
          targetRevision: targetWrite.ifRevision,
        });
        context.touch(result.target);
        return context.result(result.source, result.source, [
          { name: "target", ...batchIdentity(result.target) },
        ]);
      },
    ),
  );
  return actions;
}
