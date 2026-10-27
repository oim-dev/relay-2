import { relayClient } from "infra/tasks-api";
import { historyMessages } from "../config/history.messages";
import { WorkHistoryError, toWorkHistoryError } from "../errors/work-history.error";
import { checkpointPoint, lifecycleDetailPoint, historyView } from "../mappers/history-view";
import { pageGeneration } from "domains/relay-data";
import type { WorkGraphPointDetail, WorkHistoryGraphPage } from "../types/work-graph.type";

/**
 * Читает bounded компактное окно одного поколения; Markdown остаётся в адресном reader.
 */
export async function getWorkGraphPage(
  project: string,
  offset: number,
  version?: string,
  session?: string,
  limit = 50,
): Promise<WorkHistoryGraphPage> {
  const generation = pageGeneration(version);
  const { data } = await relayClient.read(project, "historyTimeline", {
    query: {
      offset,
      limit,
      ...(generation === undefined ? {} : { generation }),
      ...(session === undefined ? {} : { session }),
    },
  });
  return historyView(data, offset);
}

/**
 * Читает только материал выбранной точки и её сессию. Runs вложены в сессию в Relay2.
 * Проверка generation до/после исключает смесь разных версий, без повторов и свежих guards.
 */
export async function getWorkGraphPoint(
  project: string,
  ref: string,
): Promise<WorkGraphPointDetail> {
  try {
    const before = (await relayClient.read(project, "projectStatus", {})).data.generation;
    const lifecycle = /^(.*):(created|closed|started|ended)$/.exec(ref);
    const checkpoint =
      lifecycle === null
        ? (
            await relayClient.read(project, "historyCheckpoint", {
              ref: ref.replace(/:checkpoint$/, ""),
            })
          ).data
        : null;
    const sessionRef = checkpoint?.data.sessionId ?? lifecycle?.[1]?.split("~")[0];
    if (!sessionRef) {
      throw new WorkHistoryError("INVALID_ARGUMENT", historyMessages.missingAddress);
    }
    const session = (await relayClient.read(project, "historySession", { ref: sessionRef })).data;
    const runs = new Map(session.data.runs.map((run) => [run.id, run]));
    if (session.data.parentSessionId !== null && lifecycle?.[2] === "created") {
      const parent = (
        await relayClient.read(project, "historySession", { ref: session.data.parentSessionId })
      ).data;
      runs.clear();
      for (const run of parent.data.runs) {
        runs.set(run.id, run);
      }
    }
    let point;
    if (checkpoint !== null) {
      const author = runs.get(checkpoint.data.runId);
      if (!author) {
        throw new WorkHistoryError("INVALID_RESPONSE", historyMessages.missingAuthor);
      }
      point = checkpointPoint(checkpoint, author);
    } else {
      point = lifecycleDetailPoint(session, ref, runs);
    }
    if (!point) {
      throw new WorkHistoryError("NOT_FOUND", historyMessages.missingPoint);
    }
    const after = (await relayClient.read(project, "projectStatus", {})).data.generation;
    if (before !== after) {
      throw new WorkHistoryError("PAGE_CHANGED", historyMessages.changedPoint);
    }
    const run = runs.get(point.runId ?? "") ?? null;
    const previousRun = runs.get(run?.predecessorRunId ?? "") ?? null;
    return {
      point,
      session: {
        ...session.data,
        id: session.id,
        key: session.key,
        description: session.data.description ?? "",
        result: session.data.result ?? "",
      },
      run,
      previousRun,
      checkpoint:
        checkpoint === null ? null : { ...checkpoint.data, id: checkpoint.id, key: checkpoint.key },
    };
  } catch (error) {
    throw toWorkHistoryError(error);
  }
}
