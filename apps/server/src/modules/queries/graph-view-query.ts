import type { HistoryTimelineRequest, RelationNeighborhoodRequest } from "@relay/contracts";
import { booleanQuery, integerQuery, invalidInput, single } from "../../http/query";

/**
 * Проверяет транспортные поля окна; обязательность generation и границы проверяет Core.
 */
function windowQuery(
  query: URLSearchParams,
): Pick<HistoryTimelineRequest, "offset" | "limit" | "generation"> {
  const offset = integerQuery(query, "offset");
  const limit = integerQuery(query, "limit");
  const generation = integerQuery(query, "generation");
  return {
    ...(offset === undefined ? {} : { offset }),
    ...(limit === undefined ? {} : { limit }),
    ...(generation === undefined ? {} : { generation }),
  };
}

/**
 * Передаёт параметры timeline без скрытой загрузки полного historyContext.
 */
export function historyTimelineQuery(query: URLSearchParams): HistoryTimelineRequest {
  for (const key of query.keys()) {
    if (!["session", "offset", "limit", "generation"].includes(key)) {
      invalidInput(key);
    }
  }
  const session = single(query, "session");
  return { ...windowQuery(query), ...(session === null ? {} : { session }) };
}

/**
 * Сохраняет query ref дословно, включая dot-адреса; обход принадлежит Core.
 */
export function relationNeighborhoodQuery(query: URLSearchParams): RelationNeighborhoodRequest {
  for (const key of query.keys()) {
    if (
      ![
        "ref",
        "component",
        "depth",
        "direction",
        "type",
        "q",
        "offset",
        "limit",
        "generation",
      ].includes(key)
    ) {
      invalidInput(key);
    }
  }
  const component = booleanQuery(query, "component");
  const ref = single(query, "ref");
  const direction = single(query, "direction");
  const depth = integerQuery(query, "depth");
  const type = single(query, "type");
  const q = single(query, "q");
  if (
    direction !== null &&
    direction !== "both" &&
    direction !== "incoming" &&
    direction !== "outgoing"
  ) {
    invalidInput("direction");
  }
  return {
    ...windowQuery(query),
    ...(component === undefined ? {} : { component }),
    ...(ref === null ? {} : { ref }),
    ...(direction === null ? {} : { direction }),
    ...(depth === undefined ? {} : { depth }),
    ...(type === null ? {} : { type }),
    ...(q === null ? {} : { q }),
  };
}
