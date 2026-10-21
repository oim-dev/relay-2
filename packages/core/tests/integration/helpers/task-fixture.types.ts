import type { KnowledgeRecord } from "@relay/contracts";

/**
 * Приложение и автоматически созданная доска, необходимые для переноса задач.
 */
export interface ApplicationBoardFixture {
  /* Приложение с указанным в fixture уникальным slug. */
  readonly application: KnowledgeRecord<"application">;
  /* Доска, принадлежащая этому приложению. */
  readonly board: KnowledgeRecord<"board">;
}
