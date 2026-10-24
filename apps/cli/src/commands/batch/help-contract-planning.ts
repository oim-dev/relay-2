import { batchContractMessages as messages } from "../../locales/commands/batch-contract";
import {
  aliasField,
  defaultField,
  defineContract,
  nullableField,
  optionalField,
  preconditionField,
  requiredField,
  updateField,
} from "./help-contract-fields";
import type { BatchHelpContractFactory } from "./help-contract.types";

const rules = messages.rules;
const example = messages.examples;
const plan = "PLN-1";
const release = "REL-1";
const stageId = "11111111-1111-4111-8111-111111111111";

/**
 * Регистрирует фабрики планов и релизов, откладывая политики и примеры до выбора листа.
 */
export function planningHelpContractFactories(): ReadonlyMap<string, BatchHelpContractFactory> {
  return new Map([
    [
      "plan.create",
      () =>
        defineContract(
          "plan.create",
          {
            title: requiredField(),
            summary: defaultField(""),
            goal: defaultField(""),
            rationale: defaultField(""),
            boundaries: defaultField(""),
            expectedResult: defaultField(""),
            participants: defaultField([]),
            scope: defaultField([]),
          },
          [rules.planCreate, rules.text],
          {
            title: example.planTitle,
            goal: example.planGoal,
            rationale: example.planRationale,
            boundaries: example.planBoundaries,
            expectedResult: example.planExpected,
            participants: ["reviewer"],
            scope: [{ kind: "feature", id: "FEATURE-1" }],
          },
        ),
    ],
    [
      "plan.update",
      () =>
        defineContract(
          "plan.update",
          {
            title: updateField(),
            summary: updateField(),
            goal: updateField(),
            rationale: updateField(),
            boundaries: updateField(),
            expectedResult: updateField(),
            participants: updateField(),
            scope: updateField(),
          },
          [rules.planWritable, rules.planUpdate, rules.text],
          { goal: example.planGoal },
          { ref: plan },
        ),
    ],
    [
      "plan.start",
      () =>
        defineContract("plan.start", {}, [rules.planWritable, rules.planStart], {}, { ref: plan }),
    ],
    [
      "plan.complete",
      () =>
        defineContract(
          "plan.complete",
          { result: requiredField() },
          [rules.planWritable, rules.planComplete, rules.text],
          { result: example.completedResult },
          { ref: plan },
        ),
    ],
    [
      "plan.cancel",
      () =>
        defineContract(
          "plan.cancel",
          { result: requiredField() },
          [rules.planWritable, rules.planCancel, rules.text],
          { result: example.cancelledResult },
          { ref: plan },
        ),
    ],
    [
      "release.create",
      () =>
        defineContract(
          "release.create",
          {
            title: requiredField(),
            version: requiredField(),
            planIds: requiredField(),
            summary: defaultField(""),
            description: defaultField(""),
            plannedFor: optionalField(messages.noDate),
          },
          [rules.releaseCreate, rules.text],
          {
            title: example.releaseTitle,
            version: "1.0",
            planIds: [plan],
            description: example.releaseBody,
            plannedFor: "2026-11-01",
          },
        ),
    ],
    [
      "release.update",
      () =>
        defineContract(
          "release.update",
          {
            title: updateField(),
            version: updateField(),
            planIds: updateField(),
            summary: updateField(),
            description: updateField(),
            plannedFor: { ...updateField(), presence: messages.optionalDate },
          },
          [rules.releaseWritable, rules.releaseUpdate, rules.text],
          { description: example.releaseBody, plannedFor: "" },
          { ref: release },
        ),
    ],
    [
      "release.plan",
      () =>
        defineContract(
          "release.plan",
          {},
          [rules.releaseWritable, rules.releasePlan],
          {},
          { ref: release },
        ),
    ],
    [
      "release.publish",
      () =>
        defineContract(
          "release.publish",
          {},
          [rules.releaseWritable, rules.releasePublish],
          {},
          { ref: release },
        ),
    ],
    [
      "release.cancel",
      () =>
        defineContract(
          "release.cancel",
          {},
          [rules.releaseWritable, rules.releaseCancel],
          {},
          { ref: release },
        ),
    ],
    ...stageHelpContractFactories(),
  ]);
}

/**
 * Регистрирует фабрики этапов и состава; политики обеих ревизий переноса создаются по запросу.
 */
function stageHelpContractFactories(): ReadonlyMap<string, BatchHelpContractFactory> {
  const factories = new Map<string, BatchHelpContractFactory>([
    [
      "plan.stage.create",
      () =>
        defineContract(
          "plan.stage.create",
          {
            title: requiredField(),
            summary: defaultField(""),
            outcome: defaultField(""),
            completionConditions: defaultField(""),
            before: nullableField(optionalField(messages.atEnd), messages.atEnd),
          },
          [rules.stage, rules.stageCreate, rules.text],
          {
            title: example.stageTitle,
            outcome: example.stageOutcome,
            completionConditions: example.stageConditions,
            before: null,
          },
          { ref: plan },
        ),
    ],
    [
      "plan.stage.update",
      () =>
        defineContract(
          "plan.stage.update",
          {
            stageId: requiredField(),
            title: updateField(),
            summary: updateField(),
            outcome: updateField(),
            completionConditions: updateField(),
          },
          [rules.stage, rules.stageUpdate, rules.text],
          { stageId, outcome: example.stageOutcome },
          { ref: plan },
        ),
    ],
    [
      "plan.stage.move",
      () =>
        defineContract(
          "plan.stage.move",
          {
            stageId: requiredField(),
            before: nullableField(aliasField("direction"), messages.atEnd),
            direction: aliasField("before"),
          },
          [rules.stage, rules.stageMove],
          { stageId, before: null },
          { ref: plan },
        ),
    ],
    [
      "plan.stage.remove",
      () =>
        defineContract(
          "plan.stage.remove",
          { stageId: requiredField() },
          [rules.stage, rules.stageRemove],
          { stageId },
          { ref: plan },
        ),
    ],
    [
      "plan.stage.task.transfer",
      () =>
        defineContract(
          "plan.stage.task.transfer",
          {
            task: requiredField(),
            targetPlan: requiredField(),
            targetStage: requiredField(),
            reason: requiredField(),
            targetRevision: preconditionField("targetVersion"),
            targetVersion: preconditionField("targetRevision"),
          },
          [rules.transfer, rules.transferState],
          {
            task: "PRODUCT-1",
            targetPlan: "PLN-2",
            targetStage: stageId,
            targetRevision: 1,
            reason: example.transferReason,
          },
          { ref: plan },
        ),
    ],
  ]);
  for (const action of ["add", "remove"] as const) {
    factories.set(`plan.stage.task.${action}`, () =>
      defineContract(
        `plan.stage.task.${action}`,
        { stageId: requiredField(), task: requiredField() },
        [rules.stage, rules.stageTask],
        { stageId, task: "PRODUCT-1" },
        { ref: plan },
      ),
    );
  }
  return factories;
}
