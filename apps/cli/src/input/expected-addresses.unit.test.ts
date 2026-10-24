import { describe, expect, spyOn, test } from "bun:test";
import { ProjectDatabase } from "@relay/storage";
import { invokeIsolatedCli } from "../../tests/helpers/help";
import { parseExpectedAddresses } from "./expected-addresses";

describe("Привязки прочитанных адресов CLI", () => {
  test("глобальный parser отклоняет неверный guard до открытия проекта", async () => {
    const open = spyOn(ProjectDatabase, "open");
    try {
      const response = await invokeIsolatedCli([
        "document",
        "update",
        "DOC-1",
        "--if-revision",
        "1",
        "--body",
        "Новое",
        "--actor",
        "agent",
        "--expected-addresses",
        "{}",
        "--format",
        "json",
      ]);

      expect(response).toMatchObject({ exitCode: 2, stdout: "" });
      expect(JSON.parse(response.stderr)).toMatchObject({
        ok: false,
        error: { code: "INVALID_ARGUMENT", helpCommand: "relay document update --help" },
      });
      expect(open).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
  });

  test("справка с корректным guard остаётся автономной", async () => {
    const response = await invokeIsolatedCli([
      "document",
      "update",
      "--expected-addresses",
      '[{"ref":"DOC-1","expectedId":"old-id"}]',
      "--help",
    ]);

    expect(response.exitCode).toBe(0);
    expect(response.stderr).toBe("");
    expect(response.stdout).toContain("--expected-addresses");
  });

  test("guards сохраняют ref/ID дословно и допускают явный пустой набор", () => {
    expect(
      parseExpectedAddresses(
        '[{"ref":"document:DOC-1","expectedId":"entity-1"},{"ref":" старый ключ ","expectedId":" исходный-ID "}]',
      ),
    ).toEqual([
      { ref: "document:DOC-1", expectedId: "entity-1" },
      { ref: " старый ключ ", expectedId: " исходный-ID " },
    ]);
    expect(parseExpectedAddresses("[]")).toEqual([]);
  });

  test.each([
    "{}",
    "null",
    '[{"ref":"DOC-1"}]',
    '[{"ref":"DOC-1","expectedId":""}]',
    '[{"ref":"DOC-1","expectedId":"id","ifRevision":1}]',
    "[{]",
  ])("неверная форма %s отклоняется до обращения к Core", (text) => {
    expect(() => parseExpectedAddresses(text)).toThrow(expect.objectContaining({ exitCode: 2 }));
  });
});
