import { PLAN_SCOPE_KINDS } from "../planning/planning.constants";
import {
  commandAddress as address,
  commandAlias,
  commandArray,
  commandEnum,
  commandDefaults,
  commandNonblank,
  commandNullable,
  commandObject,
  commandText as text,
  commandTitle,
} from "./command-schema-fields";
import type { CommandJsonSchema } from "./command-schema.types";

const plan = {
  title: commandTitle,
  summary: text,
  goal: text,
  rationale: text,
  boundaries: text,
  expectedResult: text,
  participants: { ...commandArray(commandTitle), uniqueItems: true },
  scope: commandArray({
    oneOf: [
      address,
      commandObject({ kind: commandEnum(PLAN_SCOPE_KINDS), id: address }, ["kind", "id"]),
    ],
  }),
};
const release = {
  title: commandTitle,
  version: commandTitle,
  summary: text,
  description: text,
  plannedFor: {
    type: "string",
    pattern: "^(?:|[0-9]{4}-[0-9]{2}-[0-9]{2})$",
  } satisfies CommandJsonSchema,
  planIds: { ...commandArray(address), minItems: 1, uniqueItems: true },
};
const stage = { title: commandTitle, summary: text, outcome: text, completionConditions: text };

/**
 * Формы планирования. Перенос защищает два плана независимыми исходными guards.
 */
export const planningCommandInputs: Readonly<Record<string, CommandJsonSchema>> = {
  "plan.create": commandObject(
    commandDefaults(plan, {
      summary: "",
      goal: "",
      rationale: "",
      boundaries: "",
      expectedResult: "",
      participants: [],
      scope: [],
    }),
    ["title"],
  ),
  "plan.update": commandObject(plan, [], { minProperties: 1 }),
  "release.create": commandObject(
    commandDefaults(release, { summary: "", description: "", plannedFor: "" }),
    ["title", "version", "planIds"],
  ),
  "release.update": commandObject(release, [], { minProperties: 1 }),
  "plan.start": commandObject({}),
  "plan.complete": commandObject({ result: commandNonblank }, ["result"]),
  "plan.cancel": commandObject({ result: commandNonblank }, ["result"]),
  ...Object.fromEntries(
    ["plan", "publish", "cancel"].map((action) => [`release.${action}`, commandObject({})]),
  ),
  "plan.stage.create": commandObject(
    commandDefaults(
      { ...stage, before: commandNullable(address) },
      { summary: "", outcome: "", completionConditions: "", before: null },
    ),
    ["title"],
  ),
  "plan.stage.update": commandObject({ stageId: address, ...stage }, ["stageId"], {
    anyOf: Object.keys(stage).map((field) => ({ required: [field] })),
  }),
  "plan.stage.move": commandObject(
    { stageId: address, before: commandNullable(address), direction: commandEnum(["up", "down"]) },
    ["stageId"],
    commandAlias("before", "direction"),
  ),
  "plan.stage.remove": commandObject({ stageId: address }, ["stageId"]),
  "plan.stage.task.add": commandObject({ stageId: address, task: address }, ["stageId", "task"]),
  "plan.stage.task.remove": commandObject({ stageId: address, task: address }, ["stageId", "task"]),
  "plan.stage.task.transfer": commandObject(
    {
      task: address,
      targetPlan: address,
      targetStage: address,
      reason: commandNonblank,
      targetRevision: {
        type: "integer",
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
        description:
          "Исходная локальная CAS целевого плана; при targetVersion необязательна, при двух guards проверяются оба.",
      },
      targetVersion: {
        ...address,
        description:
          "Исходная aggregateVersion целевого плана, независимо от версии исходного плана.",
      },
    },
    ["task", "targetPlan", "targetStage", "reason"],
    { anyOf: [{ required: ["targetRevision"] }, { required: ["targetVersion"] }] },
  ),
};
