/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { readSessionStored } from "infra/browser-storage";
import { clearReleaseDraft, readReleaseDraft, writeReleaseDraft } from "./release-form-draft";
import type { ReleaseFormValues } from "../types/release-form-props.type";

describe("Черновик формы релиза в памяти вкладки", () => {
  test("возврат к форме сохраняет полный выбор, текст и исходную ревизию без sessionStorage", () => {
    const key = "release-draft-test:project:release";
    const initial: ReleaseFormValues = {
      revision: 7,
      title: "Выпуск",
      version: "2",
      summary: "Кратко",
      description: "  **Итог**\n\n",
      status: "released",
      plannedFor: "2026-10-26",
      planIds: ["hidden-plan", "visible-plan"],
    };
    const fresh = { ...initial, revision: 99, planIds: ["other-plan"] };
    try {
      const error = writeReleaseDraft(key, initial);
      const restored = readReleaseDraft(key, fresh);
      clearReleaseDraft(key);

      expect(error).toBeNull();
      expect(restored).toEqual({ values: initial, error: null });
      expect(readReleaseDraft(key, fresh)).toEqual({ values: fresh, error: null });
    } finally {
      clearReleaseDraft(key);
    }
  });

  test("draft создания не подменяет редактируемый релиз и остаётся до явного сброса", () => {
    const key = "release-draft-test:project:mode";
    const draft: ReleaseFormValues = {
      revision: 0,
      title: "Несохранённый",
      version: "3",
      summary: "",
      description: "Черновик",
      status: "planned",
      plannedFor: "",
      planIds: ["plan"],
    };
    writeReleaseDraft(key, draft);
    try {
      const result = readReleaseDraft(key, { ...draft, revision: 12, title: "Существующий" });

      expect(result).toEqual({
        values: { ...draft, revision: 12, title: "Существующий" },
        error: "Черновик релиза имеет неизвестный формат. Сбросьте его явно, чтобы продолжить.",
      });
      expect(readSessionStored(key)).toEqual({ ...draft, description: ["Черновик"] });
    } finally {
      clearReleaseDraft(key);
    }
  });
});
