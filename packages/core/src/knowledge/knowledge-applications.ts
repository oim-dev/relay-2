import { RelayError, type KnowledgeRecord } from "@relay/contracts";
import type { ProjectDatabase } from "@relay/storage";
import type { EntityService } from "../entities/entities";
import { decodeKnowledge } from "./knowledge-data";
import { knowledgeMessages } from "./knowledge.messages";
import type { ApplicationCreationData } from "./knowledge.types";

/**
 * Совместные изменения приложения и принадлежащей ему доски.
 * Методы требуют внешней транзакции KnowledgeService на том же соединении.
 */
export class KnowledgeApplications {
  /* Внутренний механизм записи с CAS и сохранением адресов. */
  private readonly entities: EntityService;
  /* Адресные проекции той же транзакции без загрузки содержания. */
  private readonly db: ProjectDatabase;

  /**
   * Принимает механизмы чтения и записи внешнего транзакционного владельца.
   */
  constructor(db: ProjectDatabase, entities: EntityService) {
    this.entities = entities;
    this.db = db;
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
   * Синхронизирует имя доски после изменения приложения в той же внешней транзакции.
   * Доска читается один раз и сохраняет собственный ключ; равное имя — no-op.
   * Отсутствие или чужой владелец доски откатывает также уже записанное приложение.
   */
  synchronizeBoard(application: KnowledgeRecord<"application">, name: string, actor: string): void {
    this.entities.changeRelated(application.data.boardId, "board", actor, (record) => {
      const board = decodeKnowledge(record, "board");
      if (board.data.applicationId !== application.id) {
        throw new RelayError("INVALID_STATE", knowledgeMessages.foreignBoard, 4);
      }
      return { patch: { name } };
    });
  }

  /**
   * Проверяет уникальность виртуального адреса сразу среди досок и приложений.
   * Коллизиями ключей и исторических алиасов дополнительно владеет EntityService.
   */
  private requireFreeAddress(data: ApplicationCreationData): void {
    const occupied = (["board", "application"] as const).some((kind) =>
      [data.slug, data.prefix].some(
        (address) => this.db.findAddressIdentities(address, kind).length > 0,
      ),
    );
    if (occupied) {
      throw new RelayError("ALREADY_EXISTS", knowledgeMessages.boardAddress, 4);
    }
  }
}
