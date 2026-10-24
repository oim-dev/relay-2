import { describe, expect, test } from "bun:test";
import {
  splitComponentRecord,
  assembleComponentRecord,
  componentMigrationId,
} from "./component-layout";
import type { ComponentSeed, PortableComponent } from "./component.types";

/**
 * Назначает технические IDs проверенным seeds только для чистой проверки assembly без SQL/crypto.
 */
function parts(ownerId: string, seeds: readonly ComponentSeed[]): PortableComponent[] {
  return seeds.map(
    (seed) =>
      ({
        ownerId,
        id: seed.id ?? componentMigrationId(ownerId, seed.kind, seed.identity),
        kind: seed.kind,
        value: seed.value,
        position: "V",
        version: "fixture",
        parents: [],
        deleted: false,
      }) as PortableComponent,
  );
}

describe("Переносимая raw-сборка нормализованных частей", () => {
  test("portable owner без revision сохраняет точный Markdown и различает отсутствующий массив и пустой", () => {
    const record = {
      id: "doc",
      kind: "document" as const,
      key: "DOC-1",
      createdAt: "2026-10-24T01:00:00.000Z",
      updatedAt: "2026-10-24T01:00:00.000Z",
      createdBy: "author",
      updatedBy: "author",
      data: { name: "Документ", body: "\ufeff\r\n\tё e\u0301  ", relations: [] },
    };

    const layout = splitComponentRecord(record);
    const assembled = assembleComponentRecord(layout.record, parts(record.id, layout.seeds));

    expect(layout.record.data).not.toHaveProperty("relations");
    expect(assembled).toEqual(record);
    expect(assembled).not.toHaveProperty("revision");
    const absent = { ...record, data: { name: "Без массива", body: "Текст" } };
    const empty = splitComponentRecord(absent);
    expect(empty.seeds).toEqual([]);
    expect(assembleComponentRecord(empty.record, [])).toEqual(absent);
  });

  test("неизвестная форма коллекции остаётся явной, а nonfinite JSON не превращается в null", () => {
    const record = {
      id: "doc",
      kind: "document" as const,
      key: "DOC-1",
      createdAt: "time",
      updatedAt: "time",
      createdBy: "author",
      updatedBy: "author",
      data: { body: "Текст", relations: null },
    };
    const layout = splitComponentRecord(record);

    expect(layout.malformed).toEqual(["relations"]);
    expect(layout.record.data.relations).toBeNull();
    expect(() => splitComponentRecord({ ...record, data: { body: Infinity } })).toThrow(
      expect.objectContaining({ code: "CORRUPT_DATA" }),
    );
  });
});
