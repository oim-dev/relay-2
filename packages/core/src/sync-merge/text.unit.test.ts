import { describe, expect, test } from "bun:test";
import { mergeText } from "./text";

const compatibleCases = [
  {
    name: "неизменная сторона сохраняет точную изменённую версию",
    base: "исходный\r\n",
    local: "\tновый  \r\n\ud800",
    remote: "исходный\r\n",
    expected: "\tновый  \r\n\ud800",
  },
  {
    name: "одинаковые версии дедуплицируются",
    base: "исходный",
    local: "новый\n",
    remote: "новый\n",
    expected: "новый\n",
  },
  {
    name: "несколько раздельных правок каждой стороны сохраняют все промежутки",
    base: "a\nb\nc\nd\ne\nf\n",
    local: "A\nb\nc\nD\ne\nf\n",
    remote: "a\nB\nc\nd\ne\nF\n",
    expected: "A\nB\nc\nD\ne\nF\n",
  },
  {
    name: "повторяющиеся строки между разными правками не теряются",
    base: "head\nsame\nleft\nsame\nright\nsame\nend\n",
    local: "head\nsame\nLEFT\nsame\nright\nsame\nend\n",
    remote: "head\nsame\nleft\nsame\nRIGHT\nsame\nend\n",
    expected: "head\nsame\nLEFT\nsame\nRIGHT\nsame\nend\n",
  },
  {
    name: "замены соседних строк независимы",
    base: "one\ntwo\nthree\n",
    local: "ONE\ntwo\nthree\n",
    remote: "one\nTWO\nthree\n",
    expected: "ONE\nTWO\nthree\n",
  },
  {
    name: "вставка перед заменяемой строкой сохраняется перед заменой",
    base: "a\nb\n",
    local: "x\na\nb\n",
    remote: "A\nb\n",
    expected: "x\nA\nb\n",
  },
  {
    name: "вставка после заменяемой строки сохраняется после замены",
    base: "a\nb\n",
    local: "A\nb\n",
    remote: "a\nx\nb\n",
    expected: "A\nx\nb\n",
  },
  {
    name: "удаление первой строки объединяется с дописыванием конца без исходного LF",
    base: "a\nb\nc",
    local: "b\nc",
    remote: "a\nb\nc\nd",
    expected: "b\nc\nd",
  },
  {
    name: "одинаковое удаление и независимая замена применяются однократно",
    base: "a\nb\nc\n",
    local: "b\nc\n",
    remote: "b\nC\n",
    expected: "b\nC\n",
  },
  {
    name: "одинаковая вставка рядом с разными заменами не удваивается",
    base: "a\nb\nc\nd\n",
    local: "a\nx\nb\nc\nD\n",
    remote: "a\nx\nb\nC\nd\n",
    expected: "a\nx\nb\nC\nD\n",
  },
  {
    name: "одинаковая замена внутри более широкого блока другой стороны дедуплицируется",
    base: "a\nb\nc\n",
    local: "A\nb\nc\n",
    remote: "A\nB\nc\n",
    expected: "A\nB\nc\n",
  },
  {
    name: "разные слова одной строки без LF объединяются",
    base: "alpha beta gamma",
    local: "ALPHA beta gamma",
    remote: "alpha beta GAMMA",
    expected: "ALPHA beta GAMMA",
  },
  {
    name: "соседние слова разделены неизменным пробелом",
    base: "red blue",
    local: "RED blue",
    remote: "red BLUE",
    expected: "RED BLUE",
  },
  {
    name: "несколько независимых замен внутри строки сохраняются все",
    base: "north middle south end",
    local: "NORTH middle SOUTH end",
    remote: "north MIDDLE south END",
    expected: "NORTH MIDDLE SOUTH END",
  },
  {
    name: "CRLF, табуляции, конечные пробелы и отсутствие последнего LF сохраняются точно",
    base: "\tfirst  \r\nsecond\t\r\nthird",
    local: "\tFIRST  \r\nsecond\t\r\nthird",
    remote: "\tfirst  \r\nsecond\t\r\nTHIRD",
    expected: "\tFIRST  \r\nsecond\t\r\nTHIRD",
  },
  {
    name: "смешанные переводы строк не приводятся к единому виду",
    base: "one\r\ntwo\n\tthree\rfour\r\n",
    local: "ONE\r\ntwo\n\tthree\rfour\r\n",
    remote: "one\r\nTWO\n\tthree\rfour\r\n",
    expected: "ONE\r\nTWO\n\tthree\rfour\r\n",
  },
  {
    name: "снятие последнего LF не отменяет замену предыдущей строки",
    base: "first\nsecond\n",
    local: "FIRST\nsecond\n",
    remote: "first\nsecond",
    expected: "FIRST\nsecond",
  },
  {
    name: "изменение слова объединяется с явной заменой CRLF на LF",
    base: "alpha beta\r\n",
    local: "ALPHA beta\r\n",
    remote: "alpha beta\n",
    expected: "ALPHA beta\n",
  },
  {
    name: "Unicode, комбинируемые символы и непарные суррогаты не перекодируются",
    base: "\ud800 начало e\u0301 😀 \udfff\nконец",
    local: "\ud800 НАЧАЛО e\u0301 😀 \udfff\nконец",
    remote: "\ud800 начало e\u0301 😀 \udfff\nКОНЕЦ",
    expected: "\ud800 НАЧАЛО e\u0301 😀 \udfff\nКОНЕЦ",
  },
  {
    name: "пословное уточнение сохраняет изменённый непарный суррогат",
    base: "\ud800A value",
    local: "\ud801A value",
    remote: "\ud800A VALUE",
    expected: "\ud801A VALUE",
  },
  {
    name: "одинаковая вставка в пустой текст применяется один раз",
    base: "",
    local: "строка\r\n",
    remote: "строка\r\n",
    expected: "строка\r\n",
  },
  {
    name: "полное одностороннее удаление сохраняет пустой результат",
    base: "строка\n",
    local: "",
    remote: "строка\n",
    expected: "",
  },
  {
    name: "удаления соседних строк не конфликтуют",
    base: "a\nb\nc\n",
    local: "b\nc\n",
    remote: "a\nc\n",
    expected: "c\n",
  },
  {
    name: "пустые строки в середине и конце сохраняются",
    base: "a\n\n\nb\n\n",
    local: "A\n\n\nb\n\n",
    remote: "a\n\n\nB\n\n",
    expected: "A\n\n\nB\n\n",
  },
  {
    name: "пустые версии дают пустой текст",
    base: "",
    local: "",
    remote: "",
    expected: "",
  },
] as const;

const conflictingCases = [
  {
    name: "разные замены одного слова конфликтуют",
    base: "word\n",
    local: "local\n",
    remote: "remote\n",
  },
  {
    name: "изменения разных букв одного слова не создают новое смешанное слово",
    base: "abcdef",
    local: "abXdef",
    remote: "abcdeY",
  },
  {
    name: "пунктуация внутри непробельного слова не разделяет конфликтующие правки",
    base: "can't",
    local: "canX't",
    remote: "can'T",
  },
  {
    name: "разные вставки строк в одну позицию конфликтуют",
    base: "a\nb\n",
    local: "a\nx\nb\n",
    remote: "a\ny\nb\n",
  },
  {
    name: "разные вставки слов в одну позицию конфликтуют",
    base: "alpha beta",
    local: "alpha LEFT beta",
    remote: "alpha RIGHT beta",
  },
  {
    name: "разные вставки в пустой текст не упорядочиваются произвольно",
    base: "",
    local: "left",
    remote: "right",
  },
  {
    name: "удаление строки против её редактирования конфликтует",
    base: "a\nb\nc\n",
    local: "a\nc\n",
    remote: "a\nB\nc\n",
  },
  {
    name: "удаление всего текста против изменения слова конфликтует",
    base: "one two\n",
    local: "",
    remote: "ONE two\n",
  },
  {
    name: "пересекающиеся многословные замены конфликтуют",
    base: "one two three\n",
    local: "one LOCAL\n",
    remote: "REMOTE three\n",
  },
  {
    name: "вставка внутри удаляемого диапазона конфликтует",
    base: "a\nb\nc\nd\n",
    local: "a\nd\n",
    remote: "a\nb\nx\nc\nd\n",
  },
  {
    name: "конкурирующие преобразования одного CRLF конфликтуют",
    base: "x\r\n",
    local: "x\n",
    remote: "x\r",
  },
  {
    name: "изменения комбинируемого символа и соседней буквы одного слова конфликтуют",
    base: "e\u0301x",
    local: "e\u0300x",
    remote: "e\u0301y",
  },
] as const;

describe("Точное трёхстороннее объединение текста", () => {
  test.each(compatibleCases)("$name", ({ base, local, remote, expected }) => {
    const result = mergeText(base, local, remote);
    const reversed = mergeText(base, remote, local);

    expect(result).toEqual({ ok: true, text: expected });
    expect(reversed).toEqual({ ok: true, text: expected });
  });

  test.each(conflictingCases)("$name", ({ base, local, remote }) => {
    const result = mergeText(base, local, remote);
    const reversed = mergeText(base, remote, local);

    expect(result).toEqual({ ok: false });
    expect(reversed).toEqual({ ok: false });
  });

  test("миллион символов неизменной строки сохраняется между двумя независимыми заменами", () => {
    const middle = "unchanged\t".repeat(100_000);
    const base = `first\n${middle}\nlast\n`;
    const local = `FIRST\n${middle}\nlast\n`;
    const remote = `first\n${middle}\nLAST\n`;

    const result = mergeText(base, local, remote);

    expect(result).toEqual({ ok: true, text: `FIRST\n${middle}\nLAST\n` });
  });

  test("редкие правки среди тысяч строк не требуют квадратичной матрицы", () => {
    const firstBlock = Array.from({ length: 2_000 }, (_, index) => `first-${index}\n`).join("");
    const secondBlock = Array.from({ length: 2_000 }, (_, index) => `second-${index}\n`).join("");
    const base = `start\n${firstBlock}middle\n${secondBlock}end\n`;
    const local = `START\n${firstBlock}middle\n${secondBlock}END\n`;
    const remote = `start\n${firstBlock}MIDDLE\n${secondBlock}end\n`;

    const result = mergeText(base, local, remote);

    expect(result).toEqual({ ok: true, text: `START\n${firstBlock}MIDDLE\n${secondBlock}END\n` });
  });

  test("слишком большой edit distance возвращает отказ без усечения", () => {
    const base = Array.from({ length: 1_000 }, (_, index) => `base-${index}\n`).join("");
    const local = Array.from({ length: 1_000 }, (_, index) => `local-${index}\n`).join("");
    const remote = Array.from({ length: 1_000 }, (_, index) => `remote-${index}\n`).join("");

    const result = mergeText(base, local, remote);

    expect(result).toEqual({ ok: false });
  });

  test("превышение числа строк возвращает отказ вместо частичного текста", () => {
    const base = "unchanged\n".repeat(100_001);
    const local = `local\n${base}`;
    const remote = `${base}remote\n`;

    const result = mergeText(base, local, remote);

    expect(result).toEqual({ ok: false });
  });

  test("превышение суммарной длины возвращает отказ до diff", () => {
    const base = "x".repeat(2_800_000);
    const local = `local\n${base}`;
    const remote = `${base}\nremote`;

    const result = mergeText(base, local, remote);

    expect(result).toEqual({ ok: false });
  });

  test("неизменная сторона допускает большой текст без запуска diff", () => {
    const base = "x".repeat(2_800_000);
    const local = `local\n${base}`;

    const result = mergeText(base, local, base);

    expect(result).toEqual({ ok: true, text: local });
  });

  test("большой конфликтующий блок не уточняется посимвольно без ограничения", () => {
    const middle = "unchanged ".repeat(600);
    const base = `first ${middle}last`;
    const local = `FIRST ${middle}last`;
    const remote = `first ${middle}LAST`;

    const result = mergeText(base, local, remote);

    expect(result).toEqual({ ok: false });
  });
});
