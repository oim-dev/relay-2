import { describe, expect, test } from "bun:test";
import {
  parsePlanningTransferWriteOptions,
  parsePlanningWriteOptions,
} from "./planning-write-options";

describe("Клиентские условия planning facade без чтения состояния", () => {
  test("version-only и constructor default не создают числовую ревизию", () => {
    const explicit = parsePlanningWriteOptions(
      { actor: "author", expectedVersion: "view-explicit" },
      "view-inherited",
    );
    const inherited = parsePlanningWriteOptions({ actor: "author" }, "view-inherited");

    expect(explicit).toEqual({ actor: "author", expectedVersion: "view-explicit" });
    expect(inherited).toEqual({ actor: "author", expectedVersion: "view-inherited" });
    expect(explicit).not.toHaveProperty("ifRevision");
    expect(inherited).not.toHaveProperty("ifRevision");
  });

  test("перенос сохраняет обе версии без numeric заглушек и не наследует token получателю", () => {
    const versionOnly = parsePlanningTransferWriteOptions(
      { actor: "author", targetVersion: "target-view" },
      "source-view",
    );
    const mixed = parsePlanningTransferWriteOptions({
      actor: "author",
      ifRevision: 4,
      expectedVersion: "source-view",
      targetRevision: 7,
      targetVersion: "target-view",
    });

    expect(versionOnly).toEqual({
      actor: "author",
      expectedVersion: "source-view",
      targetVersion: "target-view",
    });
    expect(versionOnly).not.toHaveProperty("ifRevision");
    expect(versionOnly).not.toHaveProperty("targetRevision");
    expect(mixed).toEqual({
      actor: "author",
      ifRevision: 4,
      expectedVersion: "source-view",
      targetRevision: 7,
      targetVersion: "target-view",
    });
    expect(() => parsePlanningTransferWriteOptions({ actor: "author" }, "source-view")).toThrow(
      expect.objectContaining({ code: "VALIDATION_ERROR" }),
    );
  });

  test("неверный явный token не заменяется constructor default, неверный CAS не игнорируется", () => {
    expect(() =>
      parsePlanningWriteOptions({ actor: "author", expectedVersion: "" }, "view-default"),
    ).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    expect(() =>
      parsePlanningWriteOptions({ actor: "author", ifRevision: 0, expectedVersion: "view" }),
    ).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    expect(() =>
      parsePlanningTransferWriteOptions({
        actor: "author",
        expectedVersion: "source",
        targetVersion: "target",
        targetRevision: 0,
      }),
    ).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
  });
});
