import { describe, expect, test } from "bun:test";
import { readVersionPrecondition, requireVersionPrecondition } from "./version-precondition";
import { invokeIsolatedCli } from "../../tests/helpers/help";

describe("Пара локального и переносимого предусловий CLI", () => {
  test.each([
    {
      name: "исходное предусловие update",
      argv: ["document", "update", "DOC-1", "--body-file", "-"],
      flags: ["--if-revision", "--expected-version"],
    },
    {
      name: "целевое предусловие transfer",
      argv: [
        "plan",
        "stage",
        "task",
        "transfer",
        "PLN-1",
        "TASK-1",
        "stage",
        "--target-plan",
        "PLN-2",
        "--expected-version",
        "source-token",
        "--reason-file",
        "-",
      ],
      flags: ["--target-revision", "--target-version"],
    },
  ])("$name требуется до чтения stdin", async ({ argv, flags }) => {
    const response = await invokeIsolatedCli([...argv, "--actor", "agent", "--format", "json"]);

    expect(response).toMatchObject({ exitCode: 2, stdout: "" });
    const error = JSON.parse(response.stderr).error;
    expect(error.code).toBe("INVALID_ARGUMENT");
    for (const flag of flags) {
      expect(error.message).toContain(flag);
    }
    expect(response.stderr).not.toContain("INPUT_READ_FAILED");
  });

  test.each(["--help", "--version"])(
    "%s остаётся автономным с token-only и stdin источником",
    async (information) => {
      const response = await invokeIsolatedCli([
        "document",
        "update",
        "DOC-1",
        "--body-file",
        "-",
        "--expected-version",
        "opaque-token",
        information,
      ]);

      expect(response.exitCode).toBe(0);
      expect(response.stderr).toBe("");
    },
  );

  test("legacy numeric CAS сохраняется без добавления token", () => {
    const values = { "if-revision": 7 };

    requireVersionPrecondition(values);

    expect(readVersionPrecondition(values)).toEqual({ ifRevision: 7 });
  });

  test("token-only не создаёт numeric CAS и сохраняет токен дословно", () => {
    const values = { "expected-version": " opaque version " };

    requireVersionPrecondition(values);

    expect(readVersionPrecondition(values)).toEqual({ expectedVersion: " opaque version " });
  });

  test("обе переданные формы сохраняются для проверки Core", () => {
    const values = { "if-revision": 7, "expected-version": "aggregate-token" };

    requireVersionPrecondition(values);

    expect(readVersionPrecondition(values)).toEqual({
      ifRevision: 7,
      expectedVersion: "aggregate-token",
    });
  });

  test("целевой план использует собственную пару вместо source предусловия", () => {
    const values = {
      "if-revision": 7,
      "expected-version": "source-token",
      "target-version": "target-token",
    };
    const target = { revision: "target-revision", version: "target-version" };

    requireVersionPrecondition(values, target);

    expect(readVersionPrecondition(values, target)).toEqual({ expectedVersion: "target-token" });
  });

  test.each([
    { name: "оба значения отсутствуют", values: {} },
    { name: "token пуст", values: { "expected-version": "" } },
    { name: "token состоит из пробелов", values: { "expected-version": "  " } },
    { name: "ревизия равна нулю", values: { "if-revision": 0 } },
    {
      name: "одна корректная форма не скрывает неверную вторую",
      values: { "if-revision": 3, "expected-version": "" },
    },
  ])("$name — отказ до I/O", ({ values }) => {
    expect(() => requireVersionPrecondition(values)).toThrow(
      expect.objectContaining({ code: "INVALID_ARGUMENT", exitCode: 2 }),
    );
  });
});
