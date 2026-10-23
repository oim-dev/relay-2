import type { TaskColumn } from "@relay/contracts";
import { batchContractMessages as messages } from "../../locales/commands/batch-contract";
import {
  aliasField,
  defaultField,
  defineContract,
  nullableField,
  optionalField,
  requiredField,
  updateField,
} from "./help-contract-fields";
import type { BatchFieldContract, BatchHelpContractFactory } from "./help-contract.types";

const rules = messages.rules;
const example = messages.examples;
const initialColumn: TaskColumn = "inbox";
const task = "PRODUCT-1";
const criterionId = "22222222-2222-4222-8222-222222222222";

/**
 * Регистрирует фабрики задач, связей, критериев и комментариев без подготовки подробностей.
 */
export function taskHelpContractFactories(): ReadonlyMap<string, BatchHelpContractFactory> {
  const factories = new Map<string, BatchHelpContractFactory>([
    [
      "task.create",
      () =>
        defineContract(
          "task.create",
          {
            board: defaultField("BOARD-PRODUCT"),
            title: defaultField(""),
            description: defaultField(""),
            column: defaultField(initialColumn),
            parent: nullableField(optionalField(messages.noParent), messages.noParent),
            dependencies: defaultField([]),
            related: defaultField([]),
            targets: defaultField([]),
            acceptanceCriteria: defaultField([]),
          },
          [rules.taskCreate, rules.taskTargets, rules.taskDone, rules.text],
          {
            board: "BOARD-PRODUCT",
            title: example.taskTitle,
            description: example.taskBody,
            column: initialColumn,
            parent: null,
            targets: ["FEATURE-1"],
            acceptanceCriteria: [
              {
                title: example.criterionTitle,
                summary: example.criterionSummary,
                description: example.criterionBody,
              },
            ],
          },
        ),
    ],
    [
      "task.update",
      () =>
        defineContract(
          "task.update",
          { title: updateField(), description: updateField(), targets: updateField() },
          [rules.taskUpdate, rules.taskTargets, rules.taskDone, rules.text],
          { description: example.taskBody, targets: [] },
          { ref: task },
        ),
    ],
    [
      "task.move",
      () =>
        defineContract(
          "task.move",
          { board: updateField(), column: updateField() },
          [rules.taskMove, rules.taskDone],
          { column: "done" satisfies TaskColumn },
          { ref: task },
        ),
    ],
    [
      "task.parent.set",
      () =>
        defineContract(
          "task.parent.set",
          { parent: requiredField() },
          [rules.taskParent, rules.taskDone],
          { parent: "PRODUCT-2" },
          { ref: task },
        ),
    ],
    [
      "task.parent.clear",
      () => defineContract("task.parent.clear", {}, [rules.taskParentClear], {}, { ref: task }),
    ],
    [
      "task.comment.add",
      () =>
        defineContract(
          "task.comment.add",
          { title: defaultField(""), body: requiredField() },
          [rules.comment, rules.text],
          { title: example.commentTitle, body: example.commentBody },
          { ref: task },
        ),
    ],
  ]);
  for (const op of ["task.dependency.add", "task.dependency.remove"] as const) {
    factories.set(op, () =>
      defineContract(
        op,
        { target: requiredField() },
        [rules.taskDependency, rules.taskDone],
        { target: "PRODUCT-2" },
        { ref: task },
      ),
    );
  }
  for (const op of ["task.link", "task.unlink"] as const) {
    factories.set(op, () =>
      defineContract(
        op,
        { target: requiredField() },
        [rules.taskRelated],
        { target: "PRODUCT-2" },
        { ref: task },
      ),
    );
  }
  return new Map([...factories, ...criterionHelpContractFactories()]);
}

/**
 * Создаёт политики алиасов критерия только при подготовке выбранной операции.
 */
function criterionAddress(): Readonly<Record<string, BatchFieldContract>> {
  return { id: aliasField("criterionId"), criterionId: aliasField("id") };
}

/**
 * Регистрирует фабрики вложенных критериев без создания их политик и примеров.
 */
function criterionHelpContractFactories(): ReadonlyMap<string, BatchHelpContractFactory> {
  const factories = new Map<string, BatchHelpContractFactory>([
    [
      "task.criterion.add",
      () =>
        defineContract(
          "task.criterion.add",
          { title: requiredField(), summary: defaultField(""), description: defaultField("") },
          [rules.criterion, rules.criterionAdd, rules.text],
          { title: example.criterionTitle, description: example.criterionBody },
          { ref: task },
        ),
    ],
    [
      "task.criterion.update",
      () =>
        defineContract(
          "task.criterion.update",
          {
            ...criterionAddress(),
            title: updateField(),
            summary: updateField(),
            description: updateField(),
          },
          [rules.criterion, rules.criterionUpdate, rules.text],
          { criterionId, description: example.criterionBody },
          { ref: task },
        ),
    ],
  ]);
  const actions = {
    complete: rules.criterionComplete,
    reopen: rules.criterionReopen,
    remove: rules.criterionRemove,
  } as const;
  for (const [action, rule] of Object.entries(actions)) {
    factories.set(`task.criterion.${action}`, () =>
      defineContract(
        `task.criterion.${action}`,
        criterionAddress(),
        [rules.criterion, rules.criterionAddress, rule],
        { id: criterionId },
        { ref: task },
      ),
    );
  }
  return factories;
}
