/**
 * Экранирует XML/plist, сохраняя пробелы и Unicode одного элемента.
 */
export function escapeServiceXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
