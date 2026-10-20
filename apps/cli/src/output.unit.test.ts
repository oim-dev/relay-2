import { expect, test } from "bun:test";
import { renderResult, terminalText } from "./output";

test("текст обезвреживает ANSI/OSC, C0/C1 и bidi, сохраняя Markdown, табуляцию и Unicode", () => {
  const text =
    "## Заголовок\n\n\t👩‍💻 код\r\n\u001b[31mцвет\u001b[0m\u001b]8;;https://invalid.local\u0007ссылка\u001b]8;;\u0007\u0008\u0085\u202eхвост";
  expect(terminalText(text)).toBe("## Заголовок\n\n\t👩‍💻 код\nцветссылкахвост");
  const result = { data: { body: text } };
  expect(JSON.parse(renderResult(result, "json")).data.body).toBe(text);
});

test("полное представление не обрезает длинное содержание", () => {
  const body = "# Полный текст\n\n" + "    строка с отступом\n".repeat(20_000) + "КОНЕЦ";
  const result = { data: { body } };
  expect(renderResult(result, "text")).toContain(body);
  expect(JSON.parse(renderResult(result, "json")).data.body).toBe(body);
});
