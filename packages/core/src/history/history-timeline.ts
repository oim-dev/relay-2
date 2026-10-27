import type {
  HistoryTimelinePage,
  HistoryTimelineRequest,
  HistoryTimelineSession,
  HistoryTimelineCheckpoint,
} from "@relay/contracts";
import type { ProjectStore } from "@relay/storage";
import { EntityService } from "../entities/entities";
import { viewGeneration, viewPage, viewQuery, viewText } from "../queries/view-page";
import { HistoryDecoder } from "./history-data";
import { timelineIndex } from "./history-timeline-index";
import { timelineWindow } from "./history-timeline-window";

/**
 * Читает компактную историю и generation одним snapshot без новых событий/состояний хранения.
 * Storage сканирует узкие metadata всех сессий/материалов и участников O(S+C+R), без Markdown.
 * Индекс и сортировка O(P log P) строятся один раз; HTTP возвращает только окно/closure.
 * Изменившееся поколение, повреждение и неизвестная ссылка отклоняют весь ответ.
 */
export function readHistoryTimeline(
  db: ProjectStore,
  request: HistoryTimelineRequest = {},
): HistoryTimelinePage {
  const input = viewQuery(request, ["session", "offset", "limit", "generation"]);
  const page = viewPage(input);
  const ref = viewText(input.session);
  return db.snapshot(() => {
    const generation = viewGeneration(db, page.generation);
    const sessionId =
      ref === undefined ? undefined : new EntityService(db).resolve(ref, "work-session").id;
    const sessions: HistoryTimelineSession[] = [];
    const checkpoints: HistoryTimelineCheckpoint[] = [];
    for (const record of db.listGraphSources("history")) {
      const decoder = new HistoryDecoder(record);
      decoder.metadata();
      if (record.kind === "work-session") {
        sessions.push(decoder.timelineSession());
      } else if (record.kind === "work-checkpoint") {
        checkpoints.push({
          ...decoder.checkpointHeader(),
          id: record.id,
          key: record.key,
          createdAt: decoder.timestamp(record.createdAt, "createdAt"),
        });
      } else {
        decoder.corrupt("kind");
      }
    }
    return timelineWindow(timelineIndex(sessions, checkpoints), page, generation, sessionId);
  });
}
