import type { KnowledgeRecord } from "@relay/contracts";
import { readEntity, readPage, pageGeneration } from "domains/relay-data";
import type { Board, BoardsPage } from "../types/boards.type";

/**
 * Переводит проверенную доску Core в прежнее представление навигации.
 */
export function boardView(record: KnowledgeRecord<"board">): Board {
  return {
    id: record.id,
    slug: record.data.slug,
    prefix: record.data.prefix,
    kind: record.data.applicationId === undefined ? "product" : "application",
    applicationId: record.data.applicationId ?? null,
    name: record.data.name,
    revision: record.revision,
  };
}

/**
 * Читает ограниченную страницу досок, сохраняя поколение продолжения.
 */
export async function getBoards(
  project: string,
  offset: number,
  version?: string,
): Promise<BoardsPage> {
  const page = await readPage(project, {
    kind: "board",
    offset,
    limit: 50,
    generation: pageGeneration(version),
  });
  return {
    items: page.items.map((record) => {
      if (record.kind !== "board") throw new Error("Сервер вернул не доску");
      return boardView(record);
    }),
    total: page.total,
    nextOffset: page.nextOffset,
    version: String(page.generation),
  };
}

/**
 * Разрешает адрес доски через единый resolver Core, без локальных ограничений slug.
 */
export async function getBoard(project: string, ref: string): Promise<Board> {
  const record = await readEntity(project, ref.startsWith("board:") ? ref : `board:${ref}`);
  if (record.kind !== "board") throw new Error("Выбранная сущность не является доской");
  return boardView(record);
}
