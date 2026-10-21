import type { KnowledgeRecord } from "@relay/contracts";

/**
 * Сохранённая карточка либо узкая графовая проекция на границе декодирования.
 */
export interface StoredTask {
  /* Постоянный ID задачи для результата и структурированной диагностики. */
  readonly id: string;
  /* Читаемый ключ задачи для сообщения о повреждении. */
  readonly key: string;
  /* Непроверенное содержание; форму определяет полный либо графовый декодер. */
  readonly data: unknown;
}

/**
 * Проверенные виды знаний, которые могут участвовать в выборе целей задачи.
 */
export type TaskTarget = KnowledgeRecord<"feature" | "scenario" | "implementation">;
