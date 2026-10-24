import { describe, expect, test } from "bun:test";
import { canonicalJson, parseJson, prettyJson } from "./json";

describe("Точные JSON-байты Git layout", () => {
  test("pretty JSON рекурсивно сортирует числоподобные ключи lex UTF-16 и сохраняет порядок массива", () => {
    const value = {
      "2": { "2": "два", "10": "десять", a: "e\u0301\r\n\t\ud800" },
      "10": [{ b: 2, a: 1 }, {}, []],
      "\ue000": "после surrogate pair",
      "🙂": "перед private use",
    };
    const expected = [
      "{",
      '  "10": [',
      "    {",
      '      "a": 1,',
      '      "b": 2',
      "    },",
      "    {},",
      "    []",
      "  ],",
      '  "2": {',
      '    "10": "десять",',
      '    "2": "два",',
      '    "a": "é\\r\\n\\t\\ud800"',
      "  },",
      '  "🙂": "перед private use",',
      '  "\ue000": "после surrogate pair"',
      "}",
      "",
    ].join("\n");

    expect(prettyJson(value)).toBe(expected);
    expect(parseJson(Buffer.from(expected))).toEqual(value);
    expect(canonicalJson({ "2": 2, "10": 10 })).toBe('{"10":10,"2":2}');
  });

  test.each([
    { name: "повтор поля", json: '{"field":"body","field":"summary"}' },
    { name: "эквивалентные escape ключа", json: '{"field":"body","\\u0066ield":"summary"}' },
    { name: "повтор во вложенном массиве", json: '{"a":[{"x":1,"x":2}]}' },
    { name: "переполнение JSON number", json: '{"a":1e999}' },
    { name: "BOM перед JSON", json: '\ufeff{"a":1}' },
  ])("$name отвергается до предметного декодера", ({ json }) => {
    expect(() => parseJson(Buffer.from(json))).toThrow(
      expect.objectContaining({ code: "GIT_INVALID_SNAPSHOT" }),
    );
  });

  test("скобки и escaped quotes в строках не становятся JSON-ключами соседних объектов", () => {
    const value = [{ x: '[{"x":1,"x":2}] \\ "' }, { x: "" }, ["x", "x"]];

    expect(parseJson(Buffer.from(JSON.stringify(value)))).toEqual(value);
  });

  test.each([
    { name: "NaN", value: NaN },
    { name: "Infinity", value: Infinity },
    { name: "undefined в объекте", value: { missing: undefined } },
    { name: "дырка массива", value: Array(1) },
    { name: "не-JSON объект", value: new Date(0) },
    { name: "BigInt", value: 1n },
  ])("$name не превращается в допустимое JSON-значение", ({ value }) => {
    expect(() => prettyJson(value)).toThrow(
      expect.objectContaining({ code: "GIT_INVALID_SNAPSHOT" }),
    );
  });
});
