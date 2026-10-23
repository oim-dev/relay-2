import { stripVTControlCharacters } from "node:util";

/**
 * Удаляет терминальные управляющие и bidi-последовательности из текста для человека.
 * Переводы строк, табуляция, Markdown и обычный Unicode сохраняются; JSON через это не проходит.
 */
export function terminalText(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, "")
    .replace(/\p{Cc}/gu, (character) =>
      character === "\n" || character === "\t" ? character : "",
    );
}
