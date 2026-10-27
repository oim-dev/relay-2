import { z } from "zod";

/** Фон маршрутной модалки не входит в адрес сущности и не зависит от её текущей доски. */
export const BOARD_BACKGROUND_SCHEMA = z.object({
  boardSlug: z.string(),
  search: z.string(),
  edit: z.boolean().optional(),
  canGoBack: z.boolean().optional(),
});
