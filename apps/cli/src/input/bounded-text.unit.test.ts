import { describe, expect, test } from "bun:test";
import { readBoundedText } from "./bounded-text";

const invalidUtf8 = [
  { name: "байт FF между ASCII-символами", bytes: new Uint8Array([0x41, 0xff, 0x42]) },
  { name: "оборванный многобайтовый символ в конце", bytes: new Uint8Array([0x41, 0xd0]) },
] as const;

describe("Ограниченное чтение UTF-8", () => {
  test.each(invalidUtf8)("$name отклоняется без подстановки U+FFFD", async ({ bytes }) => {
    const source = {
      /**
       * Отдаёт повреждённый внешний ввод несколькими чанками.
       */
      async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
        yield bytes.slice(0, 1);
        yield bytes.slice(1);
      },
    };

    await expect(readBoundedText(source, bytes.byteLength)).rejects.toMatchObject({
      code: "INVALID_UTF8",
      exitCode: 2,
    });
  });

  test("валидный UTF-8 сохраняет JSON escape одиночного суррогата и буквальный U+FFFD", async () => {
    const json = String.raw`{"body":"A\ud800B�"}`;
    const bytes = new TextEncoder().encode(json);
    const source = {
      /**
       * Передаёт синтаксически валидный JSON без преобразования его escape-последовательностей.
       */
      async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
        yield bytes;
      },
    };

    const text = await readBoundedText(source, bytes.byteLength);

    expect(text).toBe(json);
    expect(JSON.parse(text)).toEqual({ body: "A\ud800B�" });
  });

  test("разрыв многобайтового символа между чанками сохраняет точный текст", async () => {
    const bytes = new TextEncoder().encode("я\n  текст\n");
    const source = {
      /**
       * Разделяет первый символ после первого байта UTF-8.
       */
      async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
        yield bytes.slice(0, 1);
        yield bytes.slice(1);
      },
    };

    const text = await readBoundedText(source, bytes.byteLength);

    expect(text).toBe("я\n  текст\n");
  });

  test("суммарное превышение прекращает чтение и закрывает источник без следующих чанков", async () => {
    let closed = false;
    let reads = 0;
    const source = {
      /**
       * Каждый чанк отдельно укладывается в лимит, но их сумма превышает его.
       * Запрос следующего чанка означает потерю ограничения потокового чтения.
       */
      async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
        try {
          reads++;
          yield new Uint8Array(2);
          reads++;
          yield new Uint8Array(3);
          reads++;
          throw new Error("Чтение должно прекратиться");
        } finally {
          closed = true;
        }
      },
    };

    await expect(readBoundedText(source, 4)).rejects.toMatchObject({
      code: "INPUT_TOO_LARGE",
      exitCode: 2,
    });

    expect(reads).toBe(2);
    expect(closed).toBe(true);
  });
});
