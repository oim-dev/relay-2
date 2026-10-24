import { TASK_CRITERION_ACTIONS, TASK_CRITERION_FIELDS } from "../tasks/task-constants";
import {
  calculateTaskComment,
  calculateTaskCreate,
  calculateTaskCriterion,
  calculateTaskLink,
  calculateTaskMove,
  calculateTaskParent,
  calculateTaskUpdate,
} from "../tasks/task-command-calculators";
import {
  loadTaskCreate,
  loadTaskLink,
  loadTaskMove,
  loadTaskParent,
  loadTaskUpdate,
} from "../tasks/task-command-loaders";
import { parseTaskCriterionChange } from "../tasks/task-criterion-input";
import { taskRecord } from "../tasks/task-data";
import type { TaskCommandDelta } from "../tasks/task-command.types";
import {
  parseCreateTask,
  parseMoveTask,
  parseTaskLink,
  parseUpdateTask,
} from "../tasks/task-input";
import { batchAction } from "./batch-action";
import { batchMessages } from "./batch.messages";
import type { BatchStepContext } from "./batch-context";
import type { BatchAction, BatchAddressField } from "./batch.types";

const taskAddresses: readonly BatchAddressField[] = [
  { path: "board", kinds: ["board"] },
  { path: "parent", kinds: ["task"] },
  { path: "dependencies.*", kinds: ["task"] },
  { path: "related.*", kinds: ["task"] },
  { path: "targets.*", kinds: ["feature", "scenario", "implementation"] },
];

/**
 * Асинхронные loaders получают конечный контекст, calculators возвращают точные эффекты.
 * Граф кешируется на состояние overlay; комментарий всегда отдельный append-effect.
 */
export function taskBatchActions(): BatchAction<BatchStepContext>[] {
  const actions: BatchAction<BatchStepContext>[] = [
    batchAction(
      "task.create",
      [
        "board",
        "title",
        "description",
        "column",
        "parent",
        "dependencies",
        "related",
        "targets",
        "acceptanceCriteria",
      ],
      {
        description: batchMessages.descriptions.task,
        addresses: taskAddresses,
      },
      async (context) => {
        const input = parseCreateTask(context.input);
        const loaded = await loadTaskCreate(context.commands, input);
        const delta = calculateTaskCreate(
          input,
          loaded.context,
          loaded.allocation,
          context.commands.taskGraphCache,
        );
        context.commands.apply(delta.effects);
        const created = delta.record;
        context.created(created);
        return context.result(
          created,
          created,
          created.data.acceptanceCriteria.map((criterion) => ({
            name: "criterion",
            id: criterion.id,
            kind: "task-criterion",
            key: null,
            revision: created.revision,
          })),
        );
      },
    ),
  ];
  for (const action of ["update", "move"] as const) {
    actions.push(
      batchAction(
        `task.${action}`,
        action === "update" ? ["title", "description", "targets"] : ["board", "column"],
        {
          description: batchMessages.descriptions.task,
          ref: true,
          revisionOwner: "task",
          addresses: taskAddresses,
        },
        async (context) => {
          const ref = await context.ref("task");
          const current = taskRecord(await context.commands.get(ref, "task"));
          const write = context.write(current);
          let delta: TaskCommandDelta;
          if (action === "update") {
            const input = parseUpdateTask(context.input);
            const loaded = await loadTaskUpdate(context.commands, current, input);
            delta = calculateTaskUpdate(current, input, loaded, write, context.commands.timestamp);
          } else {
            const input = parseMoveTask(context.input);
            const loaded = await loadTaskMove(context.commands, current, input);
            delta = calculateTaskMove(
              current,
              input,
              loaded,
              write,
              context.commands.timestamp,
              context.commands.taskGraphCache,
            );
          }
          context.commands.apply(delta.effects);
          return context.result(delta.record);
        },
      ),
    );
  }
  for (const clear of [false, true]) {
    actions.push(
      batchAction(
        `task.parent.${clear ? "clear" : "set"}`,
        clear ? [] : ["parent"],
        {
          description: batchMessages.descriptions.task,
          ref: true,
          revisionOwner: "task",
          addresses: [{ path: "parent", kinds: ["task"] }],
        },
        async (context) => {
          const ref = await context.ref("task");
          const current = taskRecord(await context.commands.get(ref, "task"));
          const write = context.write(current);
          const loaded = await loadTaskParent(
            context.commands,
            clear ? null : context.text("parent"),
          );
          const delta = calculateTaskParent(
            current,
            loaded,
            write,
            context.commands.timestamp,
            context.commands.taskGraphCache,
          );
          context.commands.apply(delta.effects);
          return context.result(delta.record);
        },
      ),
    );
  }
  for (const remove of [false, true]) {
    for (const relation of ["dependency", "related"] as const) {
      const name =
        relation === "dependency"
          ? `task.dependency.${remove ? "remove" : "add"}`
          : `task.${remove ? "unlink" : "link"}`;
      actions.push(
        batchAction(
          name,
          ["target"],
          {
            description: batchMessages.descriptions.task,
            ref: true,
            revisionOwner: "task",
            addresses: [{ path: "target", kinds: ["task"] }],
          },
          async (context) => {
            const ref = await context.ref("task");
            const current = taskRecord(await context.commands.get(ref, "task"));
            const write = context.write(current);
            const change = parseTaskLink(
              relation === "dependency" ? "dependencies" : "related",
              context.text("target"),
              remove,
            );
            const loaded = await loadTaskLink(context.commands, change);
            const delta = calculateTaskLink(
              current,
              change,
              loaded,
              write,
              context.commands.timestamp,
              context.commands.taskGraphCache,
            );
            context.commands.apply(delta.effects);
            return context.result(delta.record);
          },
        ),
      );
    }
  }
  for (const action of TASK_CRITERION_ACTIONS) {
    let fields: readonly string[] = ["id", "criterionId"];
    if (action === "add") {
      fields = TASK_CRITERION_FIELDS;
    } else if (action === "update") {
      fields = ["id", "criterionId", ...TASK_CRITERION_FIELDS];
    }
    actions.push(
      batchAction(
        `task.criterion.${action}`,
        fields,
        {
          description: batchMessages.descriptions.criterion,
          ref: true,
          revisionOwner: "task",
          addresses: [
            { path: "id", kinds: ["task-criterion"] },
            { path: "criterionId", kinds: ["task-criterion"] },
          ],
        },
        async (context) => {
          const input = parseTaskCriterionChange(action, context.input);
          const ref = await context.ref("task");
          const current = taskRecord(await context.commands.get(ref, "task"));
          const write = context.write(current);
          const id = input.action === "add" ? context.commands.allocateId() : input.criterionId;
          const delta = calculateTaskCriterion(
            current,
            input,
            id,
            write,
            context.commands.timestamp,
          );
          context.commands.apply(delta.effects);
          return context.nested(delta.id, "task-criterion", delta.record);
        },
      ),
    );
  }
  actions.push(
    batchAction(
      "task.comment.add",
      ["title", "body"],
      {
        description: batchMessages.descriptions.comment,
        ref: true,
      },
      async (context) => {
        const ref = await context.ref("task");
        const current = taskRecord(await context.commands.get(ref, "task", "existence"));
        const delta = calculateTaskComment(
          current,
          context.string("body"),
          context.string("title", ""),
          {
            id: context.commands.allocateId(),
            actor: context.actor,
            timestamp: context.commands.timestamp,
          },
        );
        context.commands.apply(delta.effects);
        return context.nested(delta.id, "task-comment", delta.record);
      },
    ),
  );
  return actions;
}
