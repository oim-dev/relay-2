import { RelayError, type KnowledgeRecord, type WriteOptions } from "@relay/contracts";
import type { EntityService } from "../entities/entities";
import { decodeKnowledge } from "./knowledge-data";
import type { KnowledgeQueries } from "./knowledge-queries";
import { knowledgeMessages } from "./knowledge.messages";
import type { ApplicationCreationData, KnowledgePatchMap } from "./knowledge.types";

/**
 * Совместные изменения приложения и принадлежащей ему доски.
 * Методы требуют внешней транзакции KnowledgeService на том же соединении.
 */
export class KnowledgeApplications {
  /* Внутренний механизм записи с CAS и сохранением адресов. */
  private readonly entities: EntityService;
  /* Чтение проверенных записей той же операции. */
  private readonly queries: KnowledgeQueries;

  /**
   * Принимает механизмы чтения и записи внешнего транзакционного владельца.
   */
  constructor(entities: EntityService, queries: KnowledgeQueries) {
    this.entities = entities;
    this.queries = queries;
  }

  /**
   * Создаёт приложение вместе с доской после проверки свободного slug и префикса.
   * Любой конфликт адреса должен откатить обе записи и счётчики внешней транзакции.
   */
  create(data: ApplicationCreationData, actor: string): KnowledgeRecord<"application"> {
    this.requireFreeAddress(data);
    const application = this.entities.create(
      "application",
      "APP",
      { ...data, implementationIds: [] },
      actor,
    );
    const board = this.entities.create(
      "board",
      "BOARD",
      {
        name: data.name,
        slug: data.slug,
        prefix: data.prefix,
        description: "",
        applicationId: application.id,
      },
      actor,
      `BOARD-${data.prefix}`,
    );
    return decodeKnowledge(
      this.entities.update(
        application.id,
        "application",
        { boardId: board.id },
        { actor, ifRevision: application.revision },
      ),
      "application",
    );
  }

  /**
   * Обновляет тексты приложения и синхронно имя доски под её собственной ревизией.
   * CAS приложения проверен вызывающим; неизменные значения сохраняют обе ревизии.
   */
  update(
    current: KnowledgeRecord<"application">,
    patch: Readonly<KnowledgePatchMap["application"]>,
    write: WriteOptions,
  ): KnowledgeRecord<"application"> {
    const board =
      patch.name === undefined ? undefined : this.queries.resolve(current.data.boardId, "board");
    if (board !== undefined && board.data.applicationId !== current.id) {
      throw new RelayError("INVALID_STATE", knowledgeMessages.foreignBoard, 4);
    }
    const updated = this.entities.update(current.id, "application", { ...patch }, write);
    if (board !== undefined) {
      // Собственная ревизия доски сохраняет независимые переименования её ключа.
      this.entities.update(
        board.id,
        "board",
        { name: patch.name },
        { actor: write.actor, ifRevision: board.revision },
      );
    }
    return decodeKnowledge(updated, "application");
  }

  /**
   * Проверяет уникальность виртуального адреса сразу среди досок и приложений.
   * Коллизиями ключей и исторических алиасов дополнительно владеет EntityService.
   */
  private requireFreeAddress(data: ApplicationCreationData): void {
    const occupied =
      this.queries
        .records("board")
        .some((record) => record.data.slug === data.slug || record.data.prefix === data.prefix) ||
      this.queries
        .records("application")
        .some((record) => record.data.slug === data.slug || record.data.prefix === data.prefix);
    if (occupied) {
      throw new RelayError("ALREADY_EXISTS", knowledgeMessages.boardAddress, 4);
    }
  }
}
