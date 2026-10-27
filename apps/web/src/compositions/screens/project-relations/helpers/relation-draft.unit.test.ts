/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import {
  relationDraftKey,
  readRelationDraft,
  claimRelationDraft,
  saveRelationDraft,
  clearRelationDraft,
} from "./relation-draft";

describe("Черновик связи и владение экраном", () => {
  test("повторный mount восстанавливает ввод и первоначальную версию вместо свежего generation", () => {
    const key = relationDraftKey(crypto.randomUUID(), "document:one");
    const first = claimRelationDraft(key);
    const draft = readRelationDraft(key, "document:one", "10");
    draft.values.to = "feature:two";
    draft.values.description = "Несохранённый текст";
    draft.uncertain = true;
    saveRelationDraft(key, first, draft);
    first.dispose();
    const restored = claimRelationDraft(key);
    try {
      const value = readRelationDraft(key, "document:one", "999");

      expect(value.version).toBe("10");
      expect(value.values).toEqual({
        from: "document:one",
        to: "feature:two",
        type: "references",
        description: "Несохранённый текст",
      });
      expect(value.uncertain).toBe(true);
      expect(value).not.toHaveProperty("operationKey");
    } finally {
      clearRelationDraft(key, restored);
      restored.dispose();
    }
  });

  test("поздний ответ A не изменяет новый A после перехода A → B → A", () => {
    const project = crypto.randomUUID();
    const key = relationDraftKey(project, "document:one");
    const first = claimRelationDraft(key);
    const old = readRelationDraft(key, "document:one", "10");
    saveRelationDraft(key, first, old);
    first.dispose();
    const next = claimRelationDraft(key);
    const current = { ...old, values: { ...old.values, description: "Новый экземпляр" } };
    saveRelationDraft(key, next, current);
    try {
      expect(saveRelationDraft(key, first, old)).toBe(false);
      expect(clearRelationDraft(key, first)).toBe(false);
      first.dispose();

      expect(next.isCurrent()).toBe(true);
      expect(readRelationDraft(key, null, "20").values.description).toBe("Новый экземпляр");
      expect(
        readRelationDraft(relationDraftKey(`${project}-B`, "document:one"), "document:one", "20")
          .values.description,
      ).toBe("");
    } finally {
      clearRelationDraft(key, next);
      next.dispose();
    }
  });
});
