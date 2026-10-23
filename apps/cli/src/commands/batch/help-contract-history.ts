import type { HistoryOperator } from "@relay/contracts";
import { batchContractMessages as messages } from "../../locales/commands/batch-contract";
import {
  defaultField,
  defineContract,
  nullableField,
  optionalField,
  requiredField,
} from "./help-contract-fields";
import type { BatchFieldContract, BatchHelpContractFactory } from "./help-contract.types";

const rules = messages.rules;
const example = messages.examples;
const session = "S-33333333-3333-4333-8333-333333333333";
const intent = "CP-55555555-5555-4555-8555-555555555555";
const runId = "44444444-4444-4444-8444-444444444444";
const operatorSource: HistoryOperator["source"] = "explicit";

/**
 * Создаёт политики подключения только внутри фабрики выбранного перехода сессии.
 */
function connectionFields(): Readonly<Record<string, BatchFieldContract>> {
  return {
    client: optionalField(messages.absentText),
    sourceSessionId: optionalField(messages.absentText),
    reason: optionalField(messages.absentText),
    operator: nullableField(optionalField(messages.operatorMissing), messages.operatorNull),
  };
}

/**
 * Регистрирует фабрики поручений и переходов, не подготавливая политики и примеры при регистрации.
 */
export function historyHelpContractFactories(): ReadonlyMap<string, BatchHelpContractFactory> {
  return new Map([
    [
      "session.start",
      () =>
        defineContract(
          "session.start",
          {
            title: requiredField(),
            description: optionalField(messages.absentText),
            ...connectionFields(),
          },
          [rules.sessionStart, rules.operator, rules.text],
          {
            title: example.sessionTitle,
            description: example.sessionBody,
            client: "terminal",
            sourceSessionId: "external-session-1",
            operator: {
              name: example.operatorName,
              email: "irina@example.com",
              source: operatorSource,
            },
          },
        ),
    ],
    [
      "session.fork",
      () =>
        defineContract(
          "session.fork",
          {
            title: requiredField(),
            description: optionalField(messages.absentText),
            runId: requiredField(),
          },
          [rules.sessionFork, rules.historyRun, rules.text],
          { title: example.forkTitle, description: example.forkBody, runId },
          { ref: intent, revision: 2 },
        ),
    ],
    [
      "session.attach",
      () =>
        defineContract(
          "session.attach",
          {
            ...connectionFields(),
            operator: nullableField(
              optionalField(messages.operatorInherited),
              messages.operatorNoInheritance,
            ),
          },
          [rules.sessionAttach, rules.operator],
          { client: "terminal", operator: null },
          { ref: session },
        ),
    ],
    [
      "session.resume",
      () =>
        defineContract(
          "session.resume",
          connectionFields(),
          [rules.sessionResume, rules.operator],
          { reason: example.resumeReason },
          { ref: session, revision: 2 },
        ),
    ],
    [
      "session.takeover",
      () =>
        defineContract(
          "session.takeover",
          { ...connectionFields(), reason: requiredField() },
          [rules.sessionTakeover, rules.operator],
          { reason: example.takeoverReason },
          { ref: session },
        ),
    ],
    [
      "session.pause",
      () =>
        defineContract(
          "session.pause",
          { runId: requiredField(), reason: requiredField() },
          [rules.sessionPause, rules.historyRun],
          { runId, reason: example.pauseReason },
          { ref: session },
        ),
    ],
    [
      "session.complete",
      () =>
        defineContract(
          "session.complete",
          { runId: requiredField(), result: requiredField() },
          [rules.sessionComplete, rules.historyRun, rules.closeHistory],
          { runId, result: example.completedResult },
          { ref: session },
        ),
    ],
    [
      "session.cancel",
      () =>
        defineContract(
          "session.cancel",
          {
            runId: {
              presence: messages.conditionalCancelRun,
              omission: messages.omittedCancelRun,
              nullable: false,
            },
            result: requiredField(),
          },
          [rules.sessionCancel, rules.historyRun, rules.closeHistory],
          { runId, result: example.cancelledResult },
          { ref: session },
        ),
    ],
    ...checkpointHelpContractFactories(),
  ]);
}

/**
 * Создаёт общие политики материала только при подготовке выбранного действия.
 */
function checkpointFields(): Readonly<Record<string, BatchFieldContract>> {
  return {
    runId: requiredField(),
    title: requiredField(),
    body: requiredField(),
    summary: optionalField(messages.absentText),
    done: optionalField(messages.absentText),
    remaining: optionalField(messages.absentText),
    nextStep: optionalField(messages.absentText),
    checks: optionalField(messages.absentText),
    references: defaultField([]),
  };
}

/**
 * Регистрирует фабрики append-only материалов без построения их подробных контрактов.
 */
function checkpointHelpContractFactories(): ReadonlyMap<string, BatchHelpContractFactory> {
  const factories = new Map<string, BatchHelpContractFactory>([
    [
      "checkpoint.open",
      () =>
        defineContract(
          "checkpoint.open",
          checkpointFields(),
          [rules.checkpointOpen, rules.historyRun, rules.text],
          {
            runId,
            title: example.intentTitle,
            body: example.intentBody,
            references: ["FEATURE-1"],
          },
          { ref: session },
        ),
    ],
  ]);
  const actionRules = {
    save: rules.checkpointSave,
    complete: rules.checkpointComplete,
    cancel: rules.checkpointCancel,
  } as const;
  for (const [action, rule] of Object.entries(actionRules)) {
    factories.set(`checkpoint.${action}`, () =>
      defineContract(
        `checkpoint.${action}`,
        { ...checkpointFields(), acceptedSessionIds: defaultField([]) },
        [
          rules.checkpointExisting,
          rules.historyRun,
          rule,
          rules.checkpointAcceptance,
          ...(action === "save" ? [] : [rules.checkpointClosure]),
          rules.text,
        ],
        {
          runId,
          title: example.progressTitle,
          body: action === "cancel" ? example.cancelledResult : example.progressBody,
          checks: example.checks,
          acceptedSessionIds: [],
        },
        { ref: intent, revision: 2 },
      ),
    );
  }
  return factories;
}
