import type { HistorySession } from "@relay/contracts";
import { decodeHistoryCheckpoint, decodeHistorySession } from "../history/history-data";
import {
  historyCheckpointInput,
  historyStartInput,
  historyTransitionInput,
  invalidHistoryInput,
} from "../history/history-input";
import {
  allocateHistoryId,
  loadHistoryCheckpoint,
  loadHistoryTransition,
} from "../history/history-command-load";
import {
  calculateHistoryCheckpoint,
  calculateHistoryStart,
  calculateHistoryTransition,
} from "../history/history-command-calculate";
import { checkHistoryRevision } from "../history/history-rules";
import { historyInputMessages } from "../history/history-messages";
import { batchAction } from "./batch-action";
import { batchIdentity, type BatchStepContext } from "./batch-context";
import { batchMessages } from "./batch.messages";
import type { BatchAction, BatchOutcome } from "./batch.types";

const connectionFields = ["client", "sourceSessionId", "reason", "operator"] as const;
const transitionInputFields = {
  fork: ["title", "description", "runId"],
  pause: ["runId", "reason"],
  complete: ["runId", "result"],
  cancel: ["runId", "result"],
  attach: connectionFields,
  resume: connectionFields,
  takeover: connectionFields,
} as const;

/**
 * Сохраняет текущий run как дополнительный компактный выход; $ref остаётся ID основной сессии.
 */
function sessionResult(
  context: BatchStepContext,
  session: HistorySession,
  owner: HistorySession = session,
): BatchOutcome {
  const outputs =
    session.data.currentRunId === null
      ? []
      : [
          {
            name: "run",
            id: session.data.currentRunId,
            kind: "session-run" as const,
            key: null,
            revision: session.revision,
          },
        ];
  return context.result(session, owner, outputs);
}

/**
 * Связывает сессии и материалы с их владельцем CAS, сохраняя предметное владение run и append-only.
 */
export function historyBatchActions(): BatchAction<BatchStepContext>[] {
  const actions: BatchAction<BatchStepContext>[] = [
    batchAction(
      "session.start",
      ["title", "description", ...connectionFields],
      {
        description: batchMessages.descriptions.history,
      },
      async (context) => {
        const input = historyStartInput(context.input);
        const runId = await allocateHistoryId(context.commands);
        const id = await allocateHistoryId(context.commands);
        const delta = calculateHistoryStart(
          input,
          { id, actor: context.actor, now: context.commands.timestamp },
          runId,
        );
        context.commands.apply(delta.effects);
        const session = delta.result;
        context.created(session);
        return sessionResult(context, session);
      },
    ),
  ];
  for (const action of [
    "fork",
    "attach",
    "resume",
    "takeover",
    "pause",
    "complete",
    "cancel",
  ] as const) {
    actions.push(
      batchAction(
        `session.${action}`,
        transitionInputFields[action],
        {
          description: batchMessages.descriptions.history,
          ref: true,
          revisionOwner: action === "fork" ? "parent-session" : "work-session",
        },
        async (context) => {
          const input = historyTransitionInput(action, context.input);
          const ref = await context.ref(action === "fork" ? "work-checkpoint" : "work-session");
          const intent =
            action === "fork"
              ? decodeHistoryCheckpoint(await context.commands.get(ref, "work-checkpoint"))
              : null;
          const owner = decodeHistorySession(
            await context.commands.get(intent?.data.sessionId ?? ref, "work-session"),
          );
          if (typeof context.step.ifRevision === "number") {
            checkHistoryRevision(owner, context.step.ifRevision);
          }
          const write = context.write(owner);
          const state = await loadHistoryTransition(context.commands, owner, intent, input);
          const id = ["fork", "attach", "resume", "takeover"].includes(action)
            ? await allocateHistoryId(context.commands)
            : null;
          const delta = calculateHistoryTransition(state, input, write, {
            id,
            actor: context.actor,
            now: context.commands.timestamp,
          });
          context.commands.apply(delta.effects);
          const session = delta.result;
          if (action === "fork") {
            context.created(session);
            return sessionResult(context, session, delta.owner);
          }
          return sessionResult(context, session);
        },
      ),
    );
  }
  for (const action of ["open", "save", "complete", "cancel"] as const) {
    actions.push(
      batchAction(
        `checkpoint.${action}`,
        [
          "runId",
          "title",
          "body",
          "summary",
          "done",
          "remaining",
          "nextStep",
          "checks",
          "references",
          ...(action === "open" ? [] : ["acceptedSessionIds"]),
        ],
        {
          description: batchMessages.descriptions.checkpoint,
          ref: true,
          revisionOwner: "work-session",
          addresses: [
            { path: "references.*", kinds: [] },
            { path: "acceptedSessionIds.*", kinds: ["work-session"] },
          ],
        },
        async (context) => {
          const input = historyCheckpointInput(action, context.input);
          const originalAccepted = context.step.input.acceptedSessionIds;
          if (context.implicitCreation && Array.isArray(originalAccepted)) {
            for (const [index, original] of originalAccepted.entries()) {
              if (typeof original === "string" && original !== input.acceptedSessionIds[index]) {
                invalidHistoryInput(historyInputMessages.acceptedIdRequired);
              }
            }
          }
          const ref = await context.ref(action === "open" ? "work-session" : "work-checkpoint");
          const intent =
            action === "open"
              ? null
              : decodeHistoryCheckpoint(await context.commands.get(ref, "work-checkpoint"));
          const owner = decodeHistorySession(
            await context.commands.get(intent?.data.sessionId ?? ref, "work-session"),
          );
          if (typeof context.step.ifRevision === "number") {
            checkHistoryRevision(owner, context.step.ifRevision);
          }
          const write = context.write(owner);
          const state = await loadHistoryCheckpoint(context.commands, owner, intent, action, input);
          const id = await allocateHistoryId(context.commands);
          const delta = calculateHistoryCheckpoint(state, action, input, write, {
            id,
            actor: context.actor,
            now: context.commands.timestamp,
          });
          context.commands.apply(delta.effects);
          const checkpoint = delta.result;
          context.created(checkpoint);
          const updatedOwner = delta.owner;
          return context.result(checkpoint, updatedOwner, [
            { name: "session", ...batchIdentity(updatedOwner) },
          ]);
        },
      ),
    );
  }
  return actions;
}
