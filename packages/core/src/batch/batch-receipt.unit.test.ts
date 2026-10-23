import { describe, expect, test } from "bun:test";
import type { BatchResult, KnowledgeRecord } from "@relay/contracts";
import { decodeBatchReceipt } from "./batch-receipt";

const project: KnowledgeRecord<"project"> = {
  id: "project-id",
  kind: "project",
  key: "PROJECT",
  revision: 2,
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-02T10:00:00.000Z",
  createdBy: "author",
  updatedBy: "agent",
  data: { name: "Проект", slug: "project" },
};
const identity = { id: project.id, kind: project.kind, key: project.key, revision: 2 } as const;
const item = {
  ...identity,
  index: 0,
  op: "project.update",
  as: null,
  owner: identity,
  outputs: [],
};
const stored: BatchResult = {
  operationKey: "receipt",
  status: "committed",
  replayed: false,
  items: [item],
  entities: [project],
};
const corruptedReceipts = [
  { name: "отсутствующий состав сущностей", value: { ...stored, entities: undefined } },
  { name: "пустой список операций", value: { ...stored, items: [] } },
  { name: "чужой ключ операции", value: { ...stored, operationKey: "another-receipt" } },
  { name: "неверный индекс операции", value: { ...stored, items: [{ ...item, index: 1 }] } },
  { name: "повтор ID итоговой сущности", value: { ...stored, entities: [project, project] } },
  {
    name: "повреждённое предметное имя",
    value: { ...stored, entities: [{ ...project, data: { ...project.data, name: null } }] },
  },
] as const;

describe("Декодирование первоначальной квитанции", () => {
  test("валидный исторический результат меняет только replayed", () => {
    const restored = decodeBatchReceipt(JSON.stringify(stored), "receipt", project.id);

    expect(restored).toEqual({ ...stored, replayed: true });
  });

  test.each(corruptedReceipts)(
    "$name даёт CORRUPT_DATA вместо успешного восстановления",
    ({ value }) => {
      expect(() => decodeBatchReceipt(JSON.stringify(value), "receipt", project.id)).toThrow(
        expect.objectContaining({
          code: "CORRUPT_DATA",
          exitCode: 1,
          details: { operationKey: "receipt" },
        }),
      );
    },
  );
});
