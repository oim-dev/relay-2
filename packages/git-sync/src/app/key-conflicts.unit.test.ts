import { describe, expect, test } from "bun:test";
import { keyConflictDecision } from "./key-conflicts";

const invalidDecisions = [
  {
    name: "выбор стороны не заменяет назначение ключей",
    input: { fingerprint: "read", assignments: [], choice: "local" },
  },
  {
    name: "карта вместо массива назначений отклоняется",
    input: { fingerprint: "read", assignments: { entityId: "task-id", key: "TASK-43" } },
  },
  {
    name: "содержимое задачи не принимается вместе с назначением",
    input: {
      fingerprint: "read",
      assignments: [{ entityId: "task-id", key: "TASK-43", title: "другой заголовок" }],
    },
  },
  {
    name: "числовой ключ не преобразуется в строку",
    input: { fingerprint: "read", assignments: [{ entityId: "task-id", key: 43 }] },
  },
  {
    name: "пропущенный постоянный ID не подставляется из ключа",
    input: { fingerprint: "read", assignments: [{ key: "TASK-43" }] },
  },
  {
    name: "нестроковый исходный ключ не игнорируется",
    input: {
      fingerprint: "read",
      assignments: [{ entityId: "task-id", fromKey: 42, key: "TASK-43" }],
    },
  },
] as const;

describe("Процессный ввод решения коллизии ключей", () => {
  test("сохраняет fingerprint, постоянные ID и явно выбранные ключи", () => {
    const input = {
      fingerprint: "исходный-fingerprint",
      assignments: [
        { entityId: "task-second", key: "TASK-47" },
        { entityId: "task-first", key: "TASK-43" },
      ],
    };

    const decision = keyConflictDecision(input);

    expect(decision).toEqual(input);
  });

  test.each(invalidDecisions)("$name", ({ input }) => {
    expect(() => keyConflictDecision(input)).toThrow(
      expect.objectContaining({ code: "INVALID_ARGUMENT", exitCode: 2 }),
    );
  });

  test("сохраняет разные исходные назначения одного объекта в многошаговом пакете", () => {
    const input = {
      fingerprint: "прочитанный-fingerprint",
      assignments: [
        { entityId: "document-id", fromKey: "DOC-1", key: "DOC-10" },
        { entityId: "document-id", fromKey: "DOC-2", key: "DOC-11" },
      ],
    };

    const decision = keyConflictDecision(input);

    expect(decision).toEqual(input);
  });
});
