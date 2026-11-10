import { createHash } from "node:crypto";
import { isPortableIdentityText } from "@relay/contracts";
import { array, invalidSnapshot, keys, object, text } from "./json";
import { MARKDOWN_FIELDS, type MarkdownDescriptor } from "./markdown.types";

/**
 * Непарные surrogate не представимы в UTF-8: такие строки остаются lossless JSON escape.
 */
function markdownRepresentable(value: string): boolean {
  // Общая проверка UTF-16 здесь выбирает представление, а не запрещает пользовательский текст.
  return isPortableIdentityText(value);
}

/**
 * Связывает дескриптор с точными байтами Markdown, независимо от предметных версий Core.
 */
function byteDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Выносит well-formed тексты из переданной копии полей в raw blobs layout 2.
 * Изменяет только эту копию и карту файлов; повторный путь отклоняет до перезаписи.
 */
export function extractMarkdown(
  files: Map<string, Uint8Array>,
  directory: string,
  value: Record<string, unknown>,
  fields: readonly MarkdownDescriptor["field"][] = MARKDOWN_FIELDS,
): MarkdownDescriptor[] {
  const descriptors: MarkdownDescriptor[] = [];
  for (const field of fields) {
    const content = value[field];
    if (typeof content !== "string" || !markdownRepresentable(content)) {
      continue;
    }
    const path = `${directory}/${field}.md`;
    if (files.has(path)) {
      invalidSnapshot();
    }
    const bytes = Buffer.from(content, "utf8");
    files.set(path, bytes);
    descriptors.push({ field, digest: byteDigest(bytes) });
    delete value[field];
  }
  return descriptors;
}

/**
 * Потребляет обязательный raw blob однократно; проверяет digest layout 2 до строгого UTF-8 decode.
 * BOM, CRLF, пустая строка и отсутствие конечного LF сохраняются дословно.
 */
export function readMarkdown(
  files: Map<string, Uint8Array>,
  path: string,
  digest: string | null,
): string {
  const bytes = files.get(path);
  if (bytes === undefined || (digest !== null && byteDigest(bytes) !== digest)) {
    return invalidSnapshot();
  }
  files.delete(path);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return invalidSnapshot();
  }
}

/**
 * Восстанавливает поля только по закрытому wrapper выбранной версии layout.
 * Layout 1 принимает прежние имена, layout 2 требует field/digest для каждого raw blob;
 * lossless JSON допустим лишь для непарных surrogate и не может дублировать blob.
 */
export function restoreMarkdown(
  files: Map<string, Uint8Array>,
  directory: string,
  value: Record<string, unknown>,
  markdown: unknown,
  layoutVersion: 1 | 2,
  allowed: readonly MarkdownDescriptor["field"][] = MARKDOWN_FIELDS,
): void {
  if (
    layoutVersion === 2 &&
    allowed.some((field) => typeof value[field] === "string" && markdownRepresentable(value[field]))
  ) {
    invalidSnapshot();
  }
  const fields = new Set<string>();
  for (const entry of array(markdown)) {
    let field: string;
    let digest: string | null;
    if (layoutVersion === 1) {
      field = text(entry);
      digest = null;
    } else {
      const descriptor = object(entry);
      keys(descriptor, ["field", "digest"]);
      field = text(descriptor.field);
      digest = text(descriptor.digest);
      if (!/^[a-f0-9]{64}$/.test(digest)) {
        invalidSnapshot();
      }
    }
    if (
      !allowed.some((name) => name === field) ||
      fields.has(field) ||
      Object.hasOwn(value, field)
    ) {
      invalidSnapshot();
    }
    fields.add(field);
    value[field] = readMarkdown(files, `${directory}/${field}.md`, digest);
  }
}
