/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { writeSessionStored, readSessionStored } from "infra/browser-storage";
import { clearPlanDraft, readPlanDraft, writePlanDraft } from "./plan-form-draft";

describe("Черновик формы плана в памяти вкладки", () => {
  test("переход и возврат сохраняют Markdown и старый CAS без доступного sessionStorage", () => {
    const key = "plan-draft-test:project:plan";
    const initial = {
      revision: 7,
      title: "Мой план",
      summary: "Кратко",
      goal: "  **Цель**\n\nСтрока\n",
    };
    const fresh = { ...initial, revision: 99, goal: "Изменено другим участником" };
    try {
      const error = writePlanDraft(key, initial);
      const restored = readPlanDraft(key, fresh);
      clearPlanDraft(key);
      const cleared = readPlanDraft(key, fresh);

      expect(error).toBeNull();
      expect(restored).toEqual({ values: initial, error: null });
      expect(cleared).toEqual({ values: fresh, error: null });
    } finally {
      clearPlanDraft(key);
    }
  });

  test("невалидный снимок не принимается и не удаляется без явного сброса", () => {
    const key = "plan-draft-test:project:corrupted";
    const corrupted = {
      revision: 7,
      title: "План",
      summary: "",
      goal: "В старой форме ожидается массив",
    };
    const fallback = { revision: 8, title: "Актуальный", summary: "", goal: "Текст" };
    writeSessionStored(key, corrupted);
    try {
      const result = readPlanDraft(key, fallback);

      expect(result).toEqual({
        values: fallback,
        error: "Черновик имеет неизвестный формат. Перед новым сохранением явно сбросьте его.",
      });
      expect(readSessionStored(key)).toEqual(corrupted);
    } finally {
      clearPlanDraft(key);
    }
  });
});
