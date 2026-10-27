/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { readSessionStored, removeSessionStored, writeSessionStored } from "./session-storage";

describe("Совместимый API черновиков легаси UI", () => {
  test("старый sessionStorage не восстанавливается и не нужен для сохранения ввода в памяти", () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
    let persistenceReads = 0;
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      /**
       * Обнаруживает любой доступ к старому persistence, включая проглоченный отказ.
       */
      get(): never {
        persistenceReads++;
        throw new Error("Старое browser storage недоступно");
      },
    });
    try {
      const oldDraft = readSessionStored("project:legacy-form");
      const stored = writeSessionStored("project:legacy-form", { body: "Новый ввод", revision: 6 });
      const currentDraft = readSessionStored("project:legacy-form");

      expect(oldDraft).toBeUndefined();
      expect(stored).toBe(true);
      expect(currentDraft).toEqual({ body: "Новый ввод", revision: 6 });
      expect(persistenceReads).toBe(0);
    } finally {
      removeSessionStored("project:legacy-form");
      if (previous) {
        Object.defineProperty(globalThis, "sessionStorage", previous);
      } else {
        Reflect.deleteProperty(globalThis, "sessionStorage");
      }
    }
  });
});
