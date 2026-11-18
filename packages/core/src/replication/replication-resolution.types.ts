import type {
  ReplicationDecision,
  ReplicationDocumentTextPatch,
  ReplicationKeyDecision,
} from "@relay/contracts";

/**
 * Внутренний выбор effective-эффектов, включая отдельный ключевой ввод Core.
 */
export type ReplicationEffectiveDecision =
  | ReplicationDecision
  | (ReplicationKeyDecision & {
      /* Отдельный переносимый вариант назначения ключей. */
      readonly choice: "keys";
    });

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
