import { expect, test } from "bun:test";
import { isWellFormedAddressText } from "./entity-text";

test.each([
  { name: "пустая строка не содержит повреждённых пар", text: "", valid: true },
  { name: "обычный Unicode адрес сохраняется", text: "DOC-Привет-�", valid: true },
  { name: "пара emoji допустима", text: "DOC-📘", valid: true },
  { name: "нижняя корректная surrogate пара допустима", text: "x\ud800\udc00y", valid: true },
  { name: "верхняя корректная surrogate пара допустима", text: "x\udbff\udfffy", valid: true },
  { name: "одинокий high surrogate в конце запрещён", text: "DOC-\ud800", valid: false },
  { name: "одинокий low surrogate запрещён", text: "\udfffDOC", valid: false },
  { name: "high surrogate перед обычным символом запрещён", text: "\udbffA", valid: false },
  { name: "два high surrogate не образуют пару", text: "\ud800\ud800\udc00", valid: false },
  { name: "лишний low surrogate после пары запрещён", text: "\ud800\udc00\udc00", valid: false },
])("$name", ({ text, valid }) => {
  expect(isWellFormedAddressText(text)).toBe(valid);
});
