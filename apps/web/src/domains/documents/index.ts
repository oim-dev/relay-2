export { DOCUMENT_INPUT_SCHEMA } from "./types/document.type";
export type {
  DocumentInput,
  KnowledgeDocument,
  DocumentRelation,
  DocumentSection,
  DocumentEntity,
  LibrarySettings,
} from "./types/document.type";
export {
  DOCUMENT_KINDS,
  DOCUMENT_KIND_OPTIONS,
  DOCUMENT_STATUSES,
  DOCUMENT_STATUS_OPTIONS,
} from "./config/documents.config";
export { useDocument, useLibrarySettings } from "./hooks/use-documents.hook";
export {
  getDocument,
  saveDocument,
  attachDocuments,
  saveLibrarySections,
  documentEntityHref,
  DocumentAccessError,
} from "./adapters/documents.adapter";
