import { describe, expect, test } from "bun:test";
import type { EntityRecord } from "@relay/contracts";
import { decodeKnowledge } from "./knowledge-data";

/**
 * Создаёт сырую запись с валидной оболочкой; содержание задаёт конкретный сценарий декодирования.
 */
function knowledgeRecord(kind: EntityRecord["kind"], data: Record<string, unknown>): EntityRecord {
  return {
    id: "id",
    key: "KEY",
    kind,
    data,
    revision: 1,
    createdAt: "2026-10-21T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:00.000Z",
    createdBy: "actor",
    updatedBy: "actor",
  };
}

describe("Граница сохранённых знаний", () => {
  test("пустой seed-паспорт не дополняется вымышленными текстами", () => {
    const product = knowledgeRecord("product", {});

    const decoded = decodeKnowledge(product, "product");

    expect(decoded.data).toEqual({});
  });

  test("отсутствующие разделы проекта не превращаются в сохранённые пустые коллекции", () => {
    const project = knowledgeRecord("project", { name: "Проект", slug: "project" });

    const decoded = decodeKnowledge(project, "project");

    expect(decoded.data).toEqual({ name: "Проект", slug: "project" });
  });

  test("проверенный документ сохраняет полный текст и связь без нормализации", () => {
    const document = knowledgeRecord("document", {
      name: "Документ",
      summary: "\nАннотация\n",
      body: "\n  Полный текст\n",
      documentKind: "description",
      documentStatus: "draft",
      sectionId: null,
      pinned: false,
      relations: [
        {
          target: { kind: "feature", id: "feature-id" },
          type: "references",
          description: "\nОснование\n",
        },
      ],
    });

    const decoded = decodeKnowledge(document, "document");

    expect<EntityRecord>(decoded).toEqual(document);
    expect(decoded.data.relations).toEqual([
      {
        target: { kind: "feature", id: "feature-id" },
        type: "references",
        description: "\nОснование\n",
      },
    ]);
  });
});
