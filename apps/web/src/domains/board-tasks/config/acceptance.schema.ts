import { z } from "zod";

/** Краткое представление критерия приёмки для списка. */
export const CRITERION_SUMMARY_SCHEMA = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  completed: z.boolean(),
  completedAt: z.string().nullable(),
  completedBy: z.string().nullable(),
});
/** Полное содержание, запрашиваемое при раскрытии. */
export const CRITERION_SCHEMA = CRITERION_SUMMARY_SCHEMA.extend({ description: z.string() });
/** Снимок полной записи и ревизии задачи. */
export const CRITERION_VIEW_SCHEMA = z.object({
  criterion: CRITERION_SCHEMA,
  revision: z.number(),
});
/** Ограниченная страница критериев с общим числом. */
export const CRITERIA_PAGE_SCHEMA = z.object({
  items: z.array(CRITERION_SUMMARY_SCHEMA),
  total: z.number(),
  nextOffset: z.number().nullable(),
  version: z.string(),
  revision: z.number(),
});
