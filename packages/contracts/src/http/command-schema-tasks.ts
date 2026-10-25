import { TASK_COLUMNS } from "../tasks/tasks.constants";
import {
  commandAddress as address,
  commandAlias,
  commandArray,
  commandEnum,
  commandDefaults,
  commandNullable,
  commandNonblank,
  commandObject,
  commandText as text,
  commandTitle,
} from "./command-schema-fields";
import type { CommandJsonSchema } from "./command-schema.types";

const taskTitle: CommandJsonSchema = { type: "string", not: { pattern: "[\\r\\n\\u2028\\u2029]" } };
const criterion = { title: commandTitle, summary: text, description: text };
const criterionIdentity = { id: address, criterionId: address };
const criterionAlias = commandAlias("id", "criterionId");

/**
 * Формы задач. Пустой task.create допустим; комментарий не требует CAS содержания.
 */
export const taskCommandInputs: Readonly<Record<string, CommandJsonSchema>> = {
  "task.create": commandObject(
    commandDefaults(
      {
        board: address,
        title: taskTitle,
        description: text,
        column: commandEnum(TASK_COLUMNS),
        parent: commandNullable(address),
        dependencies: commandArray(address),
        related: commandArray(address),
        targets: commandArray(address),
        acceptanceCriteria: commandArray(
          commandObject(commandDefaults(criterion, { summary: "", description: "" }), ["title"]),
        ),
      },
      {
        board: "BOARD-PRODUCT",
        title: "",
        description: "",
        column: "inbox",
        parent: null,
        dependencies: [],
        related: [],
        targets: [],
        acceptanceCriteria: [],
      },
    ),
  ),
  "task.update": commandObject(
    { title: taskTitle, description: text, targets: commandArray(address) },
    [],
    { minProperties: 1 },
  ),
  "task.move": commandObject({ board: address, column: commandEnum(TASK_COLUMNS) }, [], {
    minProperties: 1,
  }),
  "task.parent.set": commandObject({ parent: address }, ["parent"]),
  "task.parent.clear": commandObject({}),
  ...Object.fromEntries(
    ["task.dependency.add", "task.dependency.remove", "task.link", "task.unlink"].map((op) => [
      op,
      commandObject({ target: address }, ["target"]),
    ]),
  ),
  "task.criterion.add": commandObject(
    commandDefaults(criterion, { summary: "", description: "" }),
    ["title"],
  ),
  "task.criterion.update": commandObject({ ...criterionIdentity, ...criterion }, [], {
    ...criterionAlias,
    anyOf: Object.keys(criterion).map((field) => ({ required: [field] })),
  }),
  ...Object.fromEntries(
    ["complete", "reopen", "remove"].map((action) => [
      `task.criterion.${action}`,
      commandObject(criterionIdentity, [], criterionAlias),
    ]),
  ),
  "task.comment.add": commandObject(
    { title: { ...taskTitle, default: "" }, body: commandNonblank },
    ["body"],
  ),
};
