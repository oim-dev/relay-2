import { TASK_CRITERION_ACTIONS, TASK_CRITERION_FIELDS } from "../tasks/task-constants";
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
 * Каталог задач использует существующие проверки графов и независимый журнал комментариев.
 * Каждый шаг читает актуальный граф своего состояния; кеш между изменяющими граф шагами не вводится.
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
      (context) => {
        const created = context.tasks.create(context.input, context.actor);
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
        (context) => {
          const ref = context.ref("task");
          const write = context.write(context.tasks.get(ref));
          return context.result(context.tasks[action](ref, context.input, write));
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
        (context) => {
          const ref = context.ref("task");
          return context.result(
            context.tasks.setParent(
              ref,
              clear ? null : context.text("parent"),
              context.write(context.tasks.get(ref)),
            ),
          );
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
          (context) => {
            const ref = context.ref("task");
            const write = context.write(context.tasks.get(ref));
            return context.result(
              context.tasks[relation](ref, context.text("target"), remove, write),
            );
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
        (context) => {
          const ref = context.ref("task");
          const current = context.tasks.get(ref);
          const updated = context.tasks.criterion(
            ref,
            action,
            context.input,
            context.write(current),
          );
          const previous = new Set(
            current.data.acceptanceCriteria.map((criterion) => criterion.id),
          );
          let id: string | undefined;
          if (action === "add") {
            id = updated.data.acceptanceCriteria.find(
              (criterion) => !previous.has(criterion.id),
            )?.id;
          } else {
            id = context.input.id === undefined ? context.text("criterionId") : context.text("id");
          }
          return context.nested(id, "task-criterion", updated);
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
      (context) => {
        const updated = context.tasks.comment(
          context.ref("task"),
          context.string("body"),
          context.actor,
          context.string("title", ""),
        );
        return context.nested(updated.data.comments.at(-1)?.id, "task-comment", updated);
      },
    ),
  );
  return actions;
}
