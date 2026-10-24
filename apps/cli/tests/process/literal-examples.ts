import type { HelpExampleCall } from "./help-examples.types";

/**
 * Разбирает только литеральный POSIX-синтаксис примеров на любой ОС, без исполнения shell.
 * Поддерживает кавычки, escape, комментарии и перевод строки; expansion, pipeline и redirect
 * явно отвергаются. POSIX-набор дополнительно сверяет весь результат с настоящим Bash.
 */
export function literalExampleCalls(source: string, route: number): HelpExampleCall[] {
  const calls: HelpExampleCall[] = [];
  let words: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  /**
   * Сохраняет даже явно пустой аргумент, образованный кавычками.
   */
  const finishWord = (): void => {
    if (started) {
      words.push(word);
    }
    word = "";
    started = false;
  };
  /**
   * Завершает один пример; исполняемые программы кроме relay запрещены.
   */
  const finishCommand = (): void => {
    finishWord();
    if (words.length) {
      if (words[0] !== "relay") {
        throw new Error(`Нелитеральный пример: ${words.join(" ")}`);
      }
      calls.push({ route, argv: words.slice(1) });
      words = [];
    }
  };
  for (let index = 0; index < source.length; index++) {
    const character = source[index] ?? "";
    if (quote === "'") {
      if (character === "'") {
        quote = null;
      } else {
        word += character;
      }
      continue;
    }
    if (character === "\\") {
      const next = source[++index];
      if (next === undefined) {
        throw new Error("Незавершённый escape в примере");
      }
      if (next === "\n") {
        continue;
      }
      word += quote === '"' && !['"', "\\", "$", "`"].includes(next) ? `\\${next}` : next;
      started = true;
      continue;
    }
    if (character === '"') {
      quote = quote === '"' ? null : '"';
      started = true;
      continue;
    }
    if (character === "$" || character === "`") {
      throw new Error("Expansion в копируемом примере требует отдельной shell-проверки");
    }
    if (quote === '"') {
      word += character;
      continue;
    }
    if (character === "'") {
      quote = "'";
      started = true;
      continue;
    }
    if (character === "#" && !started) {
      const newline = source.indexOf("\n", index);
      index = newline < 0 ? source.length : newline;
      finishCommand();
      continue;
    }
    if (character === "\n") {
      finishCommand();
      continue;
    }
    if (/\s/u.test(character)) {
      finishWord();
      continue;
    }
    if ("|;&<>".includes(character)) {
      throw new Error("Операторы shell в литеральном примере запрещены");
    }
    word += character;
    started = true;
  }
  if (quote) {
    throw new Error("Незавершённая кавычка в примере");
  }
  finishCommand();
  return calls;
}
