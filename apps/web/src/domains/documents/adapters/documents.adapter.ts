import { readEntity, writeCommand, writeCommands, UncertainWriteError } from "domains/relay-data";
import { getEntities } from "domains/entities";
import { ApiError, getStorageFailureMessage } from "infra/tasks-api";
import type {
  DocumentInput,
  KnowledgeDocument,
  LibrarySettings,
  DocumentSection,
  DocumentEntity,
  DocumentRelation,
} from "../types/document.type";
import { librarySectionCommands } from "../helpers/library-section-commands";

/**
 * Ожидаемый отказ чтения, CAS или неопределённая запись; исходная причина сохранена.
 */
export class DocumentAccessError extends Error {
  /* Неопределённый исход требует повторить исходное действие без новых guards. */
  readonly uncertain: boolean;

  /**
   * Сохраняет причину и различает достоверный отказ от незавершённой записи.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.uncertain = options?.cause instanceof UncertainWriteError;
  }
}

/**
 * Преобразует только ожидаемые отказы SDK и общего writer.
 */
function throwDocumentFailure(error: unknown): never {
  if (
    error instanceof ApiError ||
    error instanceof TypeError ||
    error instanceof UncertainWriteError
  ) {
    throw new DocumentAccessError(getStorageFailureMessage(error) ?? error.message, {
      cause: error,
    });
  }
  throw error;
}

/**
 * Читает документ с его исходным CAS; названия целей — отдельные адресные чтения,
 * не часть снимка документа и не основание записи.
 */
export async function getDocument(projectId: string, ref: string): Promise<KnowledgeDocument> {
  try {
    const entry = await readEntity(projectId, ref);
    if (entry.kind !== "document")
      throw new DocumentAccessError("Выбранная запись не является документом.");
    const refs = [...new Set(entry.data.relations.map((link) => link.target.id))];
    const references = (await getEntities(projectId, { refs })).items;
    return {
      ...entry.data,
      id: entry.id,
      key: entry.key,
      revision: entry.revision,
      updatedAt: entry.updatedAt,
      references,
    };
  } catch (error) {
    return throwDocumentFailure(error);
  }
}

/**
 * Пишет документ с исходной ревизией. Повтор после неопределённого исхода
 * использует frozen команду и receipt общего writer, не обновляет guards.
 */
export async function saveDocument(
  projectId: string,
  input: DocumentInput,
  requestId: string,
  existing?: { id: string; revision: number },
): Promise<{ id: string; revision: number }> {
  try {
    const result = await writeCommand(
      projectId,
      {
        op: existing ? "document.update" : "document.create",
        ...(existing ? { ref: existing.id, ifRevision: existing.revision } : {}),
        input,
      },
      requestId,
    );
    const saved = result.items[0];
    if (!saved) throw new Error("Сервер не вернул результат сохранения документа.");
    return { id: saved.id, revision: saved.revision };
  } catch (error) {
    return throwDocumentFailure(error);
  }
}

/**
 * Прикрепляет выбранные документы одним batch с ревизиями их карточек на момент
 * выбора. При любом конфликте ни одна связь не сохраняется; повтор восстанавливает receipt.
 */
export async function attachDocuments(
  project: string,
  documents: readonly { id: string; revision: number }[],
  target: DocumentRelation["target"],
  requestId: string,
): Promise<void> {
  try {
    await writeCommands(
      project,
      documents.map((document) => ({
        op: "document.link",
        ref: document.id,
        ifRevision: document.revision,
        input: { target: target.id, type: "references", description: "" },
      })),
      requestId,
    );
  } catch (error) {
    throwDocumentFailure(error);
  }
}

/**
 * Читает разделы и CAS настоящего проекта-владельца одним запросом.
 */
export async function getLibrarySettings(projectId: string): Promise<LibrarySettings> {
  try {
    const project = await readEntity(projectId, projectId);
    if (project.kind !== "project") throw new Error("Ожидался паспорт проекта.");
    return {
      ref: project.id,
      projectName: project.data.name,
      revision: project.revision,
      sections: project.data.documentSections ?? [],
    };
  } catch (error) {
    return throwDocumentFailure(error);
  }
}

/**
 * Строит атомарное изменение каталога под исходным CAS проекта. Последующие
 * шаги используют ревизию того же владельца из предыдущего результата пакета.
 * No-op также проверяет исходный CAS командой project.update без изменения имени.
 */
export async function saveLibrarySections(
  projectId: string,
  settings: LibrarySettings,
  sections: DocumentSection[],
  requestId: string,
): Promise<void> {
  try {
    await writeCommands(projectId, librarySectionCommands(settings, sections), requestId);
  } catch (error) {
    throwDocumentFailure(error);
  }
}

/**
 * Навигация по постоянному ID, не по потенциально переназначаемому ключу.
 */
export function documentEntityHref(base: string, entity: DocumentEntity): string {
  const { kind, id } = entity.ref;
  const address = encodeURIComponent(id);
  if (kind === "document") return `${base}/documents/${address}`;
  if (kind === "work-plan") return `${base}/plans/${address}`;
  if (kind === "release") return `${base}/releases/${address}`;
  if (kind === "task") return `${base}/tasks/${address}`;
  if (kind === "feature") return `${base}/product/features/${address}`;
  if (kind === "scenario") return `${base}/product/scenarios/${address}`;
  if (kind === "implementation") return `${base}/product/implementations/${address}`;
  if (kind === "application") return `${base}/product/applications/${address}`;
  if (kind === "product") return `${base}/product/passport`;
  if (kind === "project") return `${base}/settings`;
  return `${base}/relations?root=${encodeURIComponent(`${kind}:${id}`)}`;
}
