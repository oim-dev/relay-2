import type { ReplicationDocumentTextPatch } from "@relay/contracts";

/**
 * Проверенная текстовая поправка одного owner на одной boundary; не является универсальной мутацией.
 */
export interface ReplicationRecordOverride {
  /* Уникальные mutable поля документа, явно указанные человеком. */
  readonly fields: ReadonlyMap<ReplicationDocumentTextPatch["field"], string>;
  /* Автор новой ручной поправки, а не первоначального source. */
  readonly actor: string;
  /* Уже выделенное время этого решения. */
  readonly timestamp: string;
}
