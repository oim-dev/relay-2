/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { readSessionStored, writeSessionStored, removeSessionStored } from "infra/browser-storage";
import { SETTINGS_DRAFT_SCHEMA } from "../config/form.schema";
import { settingsSavePolicy, settingsSubmitInput } from "./settings-submit";

describe("Повтор сохранения настроек после собственного SSE", () => {
  test("совпавшие с SSE значения оставляют повтор receipt доступным и запрещают reset/rebase", () => {
    const submitted = { name: "Новое имя", slug: "new-name", ifRevision: 7 };
    const received = { name: "Новое имя", slug: "new-name", revision: 8 };

    const policy = settingsSavePolicy(received, submitted, 7, submitted);
    const retry = settingsSubmitInput({ name: "Иной ввод", slug: "different" }, 99, submitted);

    expect(policy).toEqual({
      hasChanges: false,
      hasConflict: false,
      canSave: true,
      canReset: false,
    });
    expect(retry).toEqual({ name: "Новое имя", slug: "new-name", ifRevision: 7 });
    expect(retry).toBe(submitted);
  });

  test("размонтирование сохраняет исходный submit в памяти, а поздняя версия не заменяет его CAS", () => {
    const key = "settings-test:project:pending";
    const values = { name: "  Моё имя  ", slug: "mine" };
    const pending = settingsSubmitInput(values, 11, undefined);
    try {
      writeSessionStored(key, { ...values, ifRevision: 11, pending });
      values.name = "Мутация объекта формы после submit";

      const restored = SETTINGS_DRAFT_SCHEMA.parse(readSessionStored(key));
      const retry = settingsSubmitInput(restored, 40, restored.pending);

      expect(restored.pending).toEqual({ name: "Моё имя", slug: "mine", ifRevision: 11 });
      expect(retry).toEqual({ name: "Моё имя", slug: "mine", ifRevision: 11 });
    } finally {
      removeSessionStored(key);
    }
  });

  test("без pending чужая версия требует явного решения, подтверждённая запись снимает блокировку", () => {
    const received = { name: "Сервер", slug: "server", revision: 18 };

    const conflict = settingsSavePolicy(
      received,
      { name: "Мой ввод", slug: "mine" },
      17,
      undefined,
    );
    const confirmed = settingsSavePolicy(received, received, 18, undefined);

    expect(conflict).toEqual({
      hasChanges: true,
      hasConflict: true,
      canSave: false,
      canReset: true,
    });
    expect(confirmed).toEqual({
      hasChanges: false,
      hasConflict: false,
      canSave: false,
      canReset: false,
    });
  });
});
