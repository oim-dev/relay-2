import type { DocumentInput } from "domains/documents";

/**
 * Исходное действие карточки до достоверного ответа, независимо от SSE.
 */
export interface DocumentAction {
  /* Поля, которые пользователь хотел изменить. */
  readonly fingerprint: string;
  /* Первоначальный выбор пользователя для явной проверки исхода. */
  readonly changes: Partial<DocumentInput>;
  /* Исходное содержание, не заменяемое новым GET. */
  readonly input: DocumentInput;
  /* Постоянный ID документа. */
  readonly id: string;
  /* Исходная ревизия документа. */
  readonly revision: number;
  /* Ключ первоначальной операции. */
  readonly requestId: string;
}
