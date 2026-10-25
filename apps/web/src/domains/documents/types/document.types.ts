import type { DocumentData, DocumentRelation, KnowledgeRecord } from "@relay/contracts";
import type { VersionedEntity } from "domains/project";

/**
 * Прочитанный документ с исходными локальной и переносимой версиями.
 */
export interface DocumentSnapshot extends VersionedEntity {
  /* Документ-владелец содержания и отношений. */
  readonly entity: KnowledgeRecord<"document">;
}

/**
 * Предметное содержание документа без служебных ключей строк формы.
 */
export interface DocumentContent {
  /* Название документа. */
  readonly name: DocumentData["name"];
  /* Краткая аннотация. */
  readonly summary: DocumentData["summary"];
  /* Исходный Markdown без преобразования форматирования. */
  readonly body: DocumentData["body"];
  /* Предметный вид документа. */
  readonly documentKind: DocumentData["documentKind"];
  /* Сохраняемое состояние публикации. */
  readonly documentStatus: DocumentData["documentStatus"];
  /* ID раздела; null оставляет документ вне раздела. */
  readonly sectionId: DocumentData["sectionId"];
  /* Закрепление в библиотеке. */
  readonly pinned: DocumentData["pinned"];
  /* Полные отношения с постоянными ID целей. */
  readonly relations: readonly DocumentRelation[];
}

/**
 * Точное действие над каталогом разделов; его CAS принадлежит проекту.
 */
export type DocumentSectionChange =
  | {
      /* Создание нового раздела, ID выделит Core. */
      readonly action: "create";
      /* Непустое имя раздела. */
      readonly name: string;
    }
  | {
      /* Переименование существующего раздела. */
      readonly action: "update";
      /* Постоянный ID раздела. */
      readonly id: string;
      /* Новое имя раздела. */
      readonly name: string;
    }
  | {
      /* Перестановка существующего раздела. */
      readonly action: "move";
      /* Постоянный ID перемещаемого раздела. */
      readonly id: string;
      /* ID следующего раздела; null означает конец списка. */
      readonly before: string | null;
    }
  | {
      /* Снятие раздела с сохранением документов. */
      readonly action: "remove";
      /* Постоянный ID снимаемого раздела. */
      readonly id: string;
    };

/**
 * Изменение одной пары «цель, тип отношения» под версией документа.
 */
export type DocumentRelationChange =
  | {
      /* Создание связи либо изменение пояснения существующей пары. */
      readonly action: "link";
      /* Цель по постоянному ID в текущем проекте. */
      readonly target: DocumentRelation["target"];
      /* Семантика отношения. */
      readonly type: DocumentRelation["type"];
      /* Пояснение связи; пустая строка допустима. */
      readonly description: string;
    }
  | {
      /* Снятие только указанной пары; остальные связи сохраняются. */
      readonly action: "unlink";
      /* Цель снимаемой связи по постоянному ID. */
      readonly target: DocumentRelation["target"];
      /* Семантика снимаемого отношения. */
      readonly type: DocumentRelation["type"];
    };
