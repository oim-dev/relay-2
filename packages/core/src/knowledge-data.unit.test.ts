import { describe, expect, test } from "bun:test";
import { RelayError, validateActor, type EntityRecord } from "@relay/contracts";
import { decodeKnowledge } from "./knowledge-data";

describe("Идентичность автора", () => {
  test.each(["Я", "agent name", "a".repeat(256)])(
    "допустимый автор сохраняется дословно: %s",
    (actor) => {
      expect(validateActor(actor)).toBe(actor);
    },
  );
  test.each([
    undefined,
    null,
    42,
    "",
    " ",
    " agent",
    "agent ",
    "agent\tname",
    "agent\0",
    "agent\n",
    "agent\u2028name",
    "agent\u2029name",
    "a".repeat(257),
  ])("некорректный автор отвергается общей ошибкой: %j", (actor) => {
    try {
      validateActor(actor);
      throw new Error("Ожидался отказ");
    } catch (error) {
      expect(error).toBeInstanceOf(RelayError);
      expect((error as RelayError).code).toBe("INVALID_ARGUMENT");
    }
  });
});

function record(kind: EntityRecord["kind"], data: Record<string, unknown>): EntityRecord {
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
  test("seed-паспорт и отсутствующие разделы не дополняются вымышленными полями", () => {
    expect(decodeKnowledge(record("product", {}), "product").data).toEqual({});
    const project = record("project", { name: "Проект", slug: "project" });
    expect(decodeKnowledge(project, "project").data).toEqual({ name: "Проект", slug: "project" });
  });

  test("проверенный документ сохраняет полный текст и связь без нормализации", () => {
    const document = record("document", {
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
    expect(decoded.data.relations[0]!.target.id).toBe("feature-id");
  });
});
