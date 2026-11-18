import { RelayError, type KnowledgeRecord, type WriteOptions } from "@relay/contracts";
import { changeCommandEntity, createCommandEntity } from "../commands/command-entity";
import { knowledgeCommandEffect } from "./knowledge-transition";
import { decodeKnowledge } from "./knowledge-data";
import { requireKnowledgeAddresses } from "./knowledge-command-addresses";
import type { KnowledgeAllocation, KnowledgeDelta } from "./knowledge-command.types";
import { knowledgeMessages } from "./knowledge.messages";
import type { ApplicationCreationData } from "./knowledge.types";

/**
 * Рассчитывает создание полного приложения и его доски с заранее выделенными взаимными ID.
 * Обе записи имеют начальную ревизию 1; сохранение выполняется одной транзакцией.
 */
export function calculateApplicationCreation(
  data: ApplicationCreationData,
  allocation: KnowledgeAllocation,
  boardAllocation: KnowledgeAllocation,
): KnowledgeDelta<"application"> {
  if (
    [...allocation.addresses, ...boardAllocation.addresses].some(
      (entry) => entry.scope === "kind" && entry.virtual.length > 0,
    )
  ) {
    throw new RelayError("ALREADY_EXISTS", knowledgeMessages.boardAddress, 4);
  }
  requireKnowledgeAddresses("application", allocation.id, allocation.addresses);
  requireKnowledgeAddresses("board", boardAllocation.id, boardAllocation.addresses);
  const record = decodeKnowledge(
    createCommandEntity(
      "application",
      allocation.key,
      {
        ...data,
        boardId: boardAllocation.id,
        implementationIds: [],
      },
      allocation,
    ),
    "application",
  );
  const board = decodeKnowledge(
    createCommandEntity(
      "board",
      boardAllocation.key,
      {
        name: data.name,
        slug: data.slug,
        prefix: data.prefix,
        description: "",
        applicationId: record.id,
      },
      boardAllocation,
    ),
    "board",
  );
  return {
    record,
    effects: [
      ...knowledgeCommandEffect(null, record, "application.create"),
      ...knowledgeCommandEffect(null, board, "application.create"),
    ],
  };
}

/**
 * Проверяет владельца доски даже при неизменном имени приложения.
 */
export function requireApplicationBoard(
  application: KnowledgeRecord<"application">,
  board: KnowledgeRecord<"board">,
): void {
  if (application.data.boardId !== board.id || board.data.applicationId !== application.id) {
    throw new RelayError("INVALID_STATE", knowledgeMessages.foreignBoard, 4);
  }
}

/**
 * Рассчитывает синхронное имя зависимой доски под её прочитанным guarded CAS; no-op сохраняет ревизию.
 */
export function calculateApplicationBoard(
  application: KnowledgeRecord<"application">,
  board: KnowledgeRecord<"board">,
  write: WriteOptions,
  timestamp: string,
): KnowledgeDelta<"board"> {
  requireApplicationBoard(application, board);
  const record = decodeKnowledge(
    changeCommandEntity(
      board,
      { name: application.data.name },
      {
        actor: write.actor,
        ifRevision: board.revision,
      },
      timestamp,
    ),
    "board",
  );
  return { record, effects: knowledgeCommandEffect(board, record, "application.update") };
}
