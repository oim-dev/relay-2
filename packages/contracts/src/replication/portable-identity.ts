/**
 * Проверяет lossless UTF-16→UTF-8 для идентичностей, адресов и SQL TEXT метаданных.
 * Markdown/JSON значения этой проверке не подчиняются: непарные code units сохраняются JSON escape.
 */
export function isPortableIdentityText(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Проверяет канонический набор непосредственных SHA-256 parents: строго возрастающий без повторов.
 */
export function isPortableVersionParents(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) {
    return false;
  }
  let previous = "";
  for (const parent of value) {
    if (typeof parent !== "string" || !/^[a-f0-9]{64}$/.test(parent) || parent <= previous) {
      return false;
    }
    previous = parent;
  }
  return true;
}
