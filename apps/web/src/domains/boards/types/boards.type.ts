import type { z } from "zod";
import type { BOARD_SCHEMA, BOARDS_PAGE_SCHEMA } from "../config/boards.schema";

/** Область работы человека внутри проекта. */
export type Board = z.infer<typeof BOARD_SCHEMA>;
/** Порция упорядоченного каталога. */
export type BoardsPage = z.infer<typeof BOARDS_PAGE_SCHEMA>;
