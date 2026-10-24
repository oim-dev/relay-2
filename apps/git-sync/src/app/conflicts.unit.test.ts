import { describe, expect, test } from "bun:test";
import { conflictDecision } from "./conflicts";
import type { ReplicationDecision } from "@relay/contracts";

describe("Закрытый вход custom conflict decision", () => {
  test("текст, transition и fingerprint передаются Core без нормализации", () => {
    const input: ReplicationDecision = {
      choice: "custom",
      fingerprint: "fingerprint",
      patch: [
        { transition: 0, entityId: "document-id", field: "body", value: "\ufeffстрока\r\n\ud800" },
      ],
    };

    const decision = conflictDecision(input);

    expect(decision).toEqual(input);
  });

  test("произвольный JSON path и дробный индекс отвергаются до Core", () => {
    expect(() =>
      conflictDecision({
        choice: "custom",
        fingerprint: "x",
        patch: [{ transition: 0, entityId: "id", field: "status", value: "done" }],
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    expect(() =>
      conflictDecision({
        choice: "custom",
        fingerprint: "x",
        patch: [{ transition: 0.5, entityId: "id", field: "body", value: "текст" }],
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });

  test("patch не игнорируется молча при выборе стороны", () => {
    expect(() => conflictDecision({ choice: "local", fingerprint: "x", patch: [] })).toThrow(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    );
  });
});
