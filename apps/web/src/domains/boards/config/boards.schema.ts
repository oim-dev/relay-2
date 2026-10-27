import { z } from "zod";

/** Проверяемый контракт доски из выбранного проекта. */
export const BOARD_SCHEMA = z.object({
  id: z.string(),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  prefix: z.string(),
  kind: z.enum(["product", "application", "infrastructure"]),
  applicationId: z.string().nullable(),
  name: z.string(),
  revision: z.number().int().positive(),
});
/** Страница каталога, включая границу продолжения. */
export const BOARDS_PAGE_SCHEMA = z.object({
  items: z.array(BOARD_SCHEMA),
  total: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
  version: z.string(),
});
