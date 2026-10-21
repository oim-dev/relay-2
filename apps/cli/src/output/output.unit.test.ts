import { describe, expect, test } from "bun:test";
import { renderResult, terminalText } from "./output";

const unsafeText =
  "## Заголовок\n\n\t👩‍💻 код\r\n\u001b[31mцвет\u001b[0m\u001b]8;;https://invalid.local\u0007ссылка\u001b]8;;\u0007\u0008\u0085\u202eхвост";
const longBody = "# Полный текст\n\n" + "    строка с отступом\n".repeat(20_000) + "КОНЕЦ";

describe("Представление результата CLI", () => {
  test("терминальный текст обезвреживает ANSI/OSC, C0/C1 и bidi, сохраняя Markdown и Unicode", () => {
    const rendered = terminalText(unsafeText);

    expect(rendered).toBe("## Заголовок\n\n\t👩‍💻 код\nцветссылкахвост");
  });

  test("JSON сохраняет исходные управляющие символы как данные", () => {
    const result = { data: { body: unsafeText } };

    const rendered = renderResult(result, "json");

    const decoded: unknown = JSON.parse(rendered);
    expect(decoded).toEqual({ ok: true, data: { body: unsafeText } });
  });

  test("полное текстовое представление не обрезает длинное содержание", () => {
    const result = { data: { body: longBody } };

    const rendered = renderResult(result, "text");

    expect(rendered).toContain(longBody);
  });

  test("полное JSON-представление не обрезает длинное содержание", () => {
    const result = { data: { body: longBody } };

    const rendered = renderResult(result, "json");

    const decoded: unknown = JSON.parse(rendered);
    expect(decoded).toEqual({ ok: true, data: { body: longBody } });
  });
});
