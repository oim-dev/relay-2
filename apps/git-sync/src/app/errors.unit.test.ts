import { describe, expect, test } from "bun:test";
import { RelayError } from "@relay/contracts";
import { failure } from "./errors";

describe("Безопасная JSON-диагностика Git Sync", () => {
  test("Authorization и credentials скрываются без повреждения JSON envelope и остальных полей", () => {
    const details = {
      operation: "fetch",
      reason: "Authorization: Bearer secret-token\nremote: ftp://user:pass@secret@host/repo",
      nested: ["https://host/repo?access_token=private&branch=data"],
    };

    const response = failure(new RelayError("GIT_FAILED", "Ошибка Git.", 4, details));

    expect(JSON.parse(JSON.stringify(response))).toEqual({
      version: 1,
      ok: false,
      error: {
        code: "GIT_FAILED",
        message: "Ошибка Git.",
        exitCode: 4,
        details: {
          operation: "fetch",
          reason: "Authorization: ***\nremote: ftp://***@host/repo",
          nested: ["https://host/repo?access_token=***&branch=data"],
        },
      },
    });
    expect(details.reason).toContain("secret-token");
  });
});
