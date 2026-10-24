import type {
  ProjectEntity,
  TaskRecord,
  WorkPlanRecord,
  HistorySession,
  HistoryCheckpoint,
} from "@relay/contracts";
import type { TaskGraph } from "../tasks/task-graph";
import type { DocumentSectionIndex } from "../knowledge/document-sections.types";

/**
 * Однократно декодированное состояние кандидата для межзаписных и переходных правил.
 */
export interface ReplicationIndex {
  /* Все проверенные записи по постоянным ID. */
  readonly byId: ReadonlyMap<string, ProjectEntity>;
  /* Задачи того же снимка. */
  readonly tasks: readonly TaskRecord[];
  /* Планы того же снимка. */
  readonly plans: readonly WorkPlanRecord[];
  /* Рабочие сессии того же снимка. */
  readonly sessions: readonly HistorySession[];
  /* Неизменяемые материалы истории того же снимка. */
  readonly checkpoints: readonly HistoryCheckpoint[];
  /* Единственный общий граф задач для всех правил кандидата. */
  readonly graph: TaskGraph;
  /* Точный активный/retired состав разделов из той же canonical boundary. */
  readonly sections: DocumentSectionIndex;
}
