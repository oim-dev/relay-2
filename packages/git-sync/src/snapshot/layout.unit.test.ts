import { describe, expect, test } from "bun:test";
import { decodeManifest, encodeManifest, rowFilePath, rowFileTable } from "./layout";

const manifest = '{"layoutVersion":3,"formatVersion":1,"modelVersion":2,"projectId":"project"}';
const digest = "a".repeat(64);

describe("Manifest табличного Git layout", () => {
  test("writer фиксирует layout 3 и логическую модель в точных JSON bytes", () => {
    const bytes = encodeManifest("project");

    expect(Buffer.from(bytes).toString("utf8")).toBe(
      '{\n  "formatVersion": 1,\n  "layoutVersion": 3,\n  "modelVersion": 2,\n  "projectId": "project"\n}\n',
    );
    expect(decodeManifest(bytes, "project")).toBe("project");
  });

  test.each([
    { name: "layout 1", versions: { layoutVersion: 1, formatVersion: 1, modelVersion: 2 } },
    { name: "layout 2", versions: { layoutVersion: 2, formatVersion: 1, modelVersion: 2 } },
    { name: "будущий layout", versions: { layoutVersion: 4, formatVersion: 1, modelVersion: 2 } },
    {
      name: "строковый layout",
      versions: { layoutVersion: "3", formatVersion: 1, modelVersion: 2 },
    },
    { name: "будущий format", versions: { layoutVersion: 3, formatVersion: 2, modelVersion: 2 } },
    { name: "прежняя model", versions: { layoutVersion: 3, formatVersion: 1, modelVersion: 1 } },
  ])("$name отклоняется явно без преобразования данных", ({ versions }) => {
    const bytes = Buffer.from(JSON.stringify({ ...versions, projectId: "project" }));

    expect(() => decodeManifest(bytes)).toThrow(
      expect.objectContaining({ code: "GIT_FORMAT_INCOMPATIBLE" }),
    );
  });

  test.each([
    { name: "лишнее поле", json: manifest.replace("}", ',"sqlVersion":6}') },
    { name: "отсутствующий projectId", json: manifest.replace(',"projectId":"project"', "") },
    { name: "пустой projectId", json: manifest.replace('"project"', '""') },
    { name: "непарный surrogate в projectId", json: manifest.replace('"project"', '"\\ud800"') },
  ])("$name нарушает закрытый manifest", ({ json }) => {
    expect(() => decodeManifest(Buffer.from(json))).toThrow(
      expect.objectContaining({ code: "GIT_INVALID_SNAPSHOT" }),
    );
  });

  test("ожидаемый projectId сравнивается дословно", () => {
    expect(() => decodeManifest(Buffer.from(manifest), "Project")).toThrow(
      expect.objectContaining({ code: "GIT_PROJECT_MISMATCH" }),
    );
  });
});

describe("Имена строк переносимых таблиц", () => {
  test("одиночный и составной PK используют SHA-256 компактного JSON кортежа", () => {
    expect(rowFilePath("documents", ["document"])).toBe(
      "documents/e7257328718867592a3ff93af91a9f6b7425658aabc493a80a992e2d5c2e8c5d.json",
    );
    expect(rowFilePath("task_criteria", ["task", "criterion"])).toBe(
      "task_criteria/8c7bf067bcd4e2f8d8de45971d3a05dcdae7c3264fa16a349425611d9743c325.json",
    );
  });

  test("составной PK различает порядок, типы и границы значений", () => {
    const keys = [
      ["a", "bc"],
      ["ab", "c"],
      ["bc", "a"],
      ["a", 1],
      ["a", "1"],
    ];

    const paths = keys.map((key) => rowFilePath("task_criteria", key));

    expect(new Set(paths).size).toBe(keys.length);
    expect(paths.every((path) => /^task_criteria\/[a-f0-9]{64}\.json$/.test(path))).toBe(true);
  });

  test("опасный и длинный PK не становится частью filesystem path", () => {
    const path = rowFilePath("documents", ["CON:<id>/../🙂\\" + "x".repeat(1024)]);

    expect(path).toMatch(/^documents\/[a-f0-9]{64}\.json$/);
    expect(path.split("/")[1]?.length).toBe(69);
    expect(rowFileTable(path)).toBe("documents");
  });

  test("имя сохраняет различия регистра и Unicode без зависимости от filesystem", () => {
    const paths = ["ID", "id", "é", "e\u0301"].map((id) => rowFilePath("documents", [id]));

    expect(new Set(paths.map((path) => path.toLowerCase())).size).toBe(paths.length);
  });

  test.each([
    { name: "обход родителя", path: `../documents/${digest}.json` },
    { name: "абсолютный путь", path: `/documents/${digest}.json` },
    { name: "Windows-разделитель", path: `documents\\${digest}.json` },
    { name: "лишний уровень", path: `documents/${digest}/record.json` },
    { name: "uppercase таблицы", path: `Documents/${digest}.json` },
    { name: "uppercase digest", path: `documents/${digest.toUpperCase()}.json` },
    { name: "укороченный digest", path: "documents/abc.json" },
    { name: "другой suffix", path: `documents/${digest}.JSON` },
    { name: "нулевой байт", path: `documents/${digest}.json\0` },
    { name: "дополнительный newline", path: `documents/${digest}.json\n` },
  ])("$name не является путём строки", ({ path }) => {
    expect(() => rowFileTable(path)).toThrow(
      expect.objectContaining({ code: "GIT_INVALID_SNAPSHOT" }),
    );
  });
});
