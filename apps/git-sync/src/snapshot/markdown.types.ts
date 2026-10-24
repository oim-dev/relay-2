/**
 * Закрытые имена вынесенных текстов владельцев и составных частей.
 */
export const MARKDOWN_FIELDS = ["body", "description", "summary"] as const;

/**
 * Дескриптор raw UTF-8 blob в layout 2; SHA-256 относится только к точным байтам этого файла.
 * Непарные surrogate остаются строкой JSON без дескриптора.
 */
export interface MarkdownDescriptor {
  /* Имя поля одновременно задаёт соседний путь <field>.md, без пользовательского пути. */
  readonly field: (typeof MARKDOWN_FIELDS)[number];
  /* Lowercase hex SHA-256 UTF-8 bytes без нормализации BOM, CRLF или конечного LF. */
  readonly digest: string;
}
