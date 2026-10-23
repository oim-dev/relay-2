import type { HistorySession } from "@relay/contracts";
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
      (context) => {
        const session = context.history.start(context.input, context.actor);
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
        (context) => {
          const ref = context.ref(action === "fork" ? "work-checkpoint" : "work-session");
          const ownerRef =
            action === "fork" ? context.history.getCheckpoint(ref).data.sessionId : ref;
          const owner = context.history.get(ownerRef);
          const session = context.history.transition(
            ref,
            action,
            context.input,
            context.write(owner),
          );
          if (action === "fork") {
            context.created(session);
            return sessionResult(context, session, context.history.get(owner.id));
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
        (context) => {
          const ref = context.ref(action === "open" ? "work-session" : "work-checkpoint");
          const ownerRef =
            action === "open" ? ref : context.history.getCheckpoint(ref).data.sessionId;
          const owner = context.history.get(ownerRef);
          const checkpoint = context.history.checkpoint(
            ref,
            action,
            context.input,
            context.write(owner),
          );
          context.created(checkpoint);
          const updatedOwner = context.history.get(owner.id);
          return context.result(checkpoint, updatedOwner, [
            { name: "session", ...batchIdentity(updatedOwner) },
          ]);
        },
      ),
    );
  }
  return actions;
}
