import { describe, expect, test } from "bun:test";
import { spawnDiagnostic } from "./diagnostics";
import { createRequest, decodeOutcome, decodeResponse } from "./protocol";

const request = createRequest({
  component: ["fixture-helper"],
  argv: ["fixture-command"],
  cwd: "/fixture",
  env: {},
  timeoutMs: 1000,
  maxOutputBytes: 0,
});
const failure = { version: 1, kind: "failure", reason: "spawn" } as const;

describe("Безопасная диагностика native отказа", () => {
  test("legacy отказ без optional полей сохраняется", () => {
    expect(decodeOutcome(failure)).toEqual(failure);
  });

  test("ENOENT проходит private response при нулевом бюджете вывода", () => {
    const response = {
      ...failure,
      stage: "command-spawn",
      systemCode: "ENOENT",
      stdout: "",
      stderr: "",
    } as const;

    expect(decodeResponse(response, request)).toEqual(response);
  });

  test("числовой Win32-код проверяется как uint32 без обращения к native API", () => {
    const outcome = { ...failure, stage: "container-setup", systemCode: 0xffff_ffff } as const;

    expect(decodeOutcome(outcome)).toEqual(outcome);
    expect(() => decodeOutcome({ ...outcome, systemCode: 0x1_0000_0000 })).toThrow(
      expect.objectContaining({ reason: "protocol" }),
    );
  });

  test.each([
    { name: "код без этапа", fields: { systemCode: "ENOENT" } },
    { name: "произвольный этап", fields: { stage: "spawn /private/token", systemCode: "ENOENT" } },
    {
      name: "сообщение вместо errno",
      fields: { stage: "command-spawn", systemCode: "ENOENT: /private/token" },
    },
    {
      name: "лишнее native message",
      fields: { stage: "command-spawn", systemCode: "ENOENT", message: "private-token" },
    },
  ])("$name отвергается строгим decoder", ({ fields }) => {
    expect(() => decodeOutcome({ ...failure, ...fields })).toThrow(
      expect.objectContaining({ reason: "protocol" }),
    );
  });

  test("новые поля не обходят raw-byte budget и запрещены в success frame", () => {
    const diagnostic = { stage: "command-spawn", systemCode: "ENOENT" };

    expect(() =>
      decodeResponse({ ...failure, ...diagnostic, stdout: "YQ==", stderr: "" }, request),
    ).toThrow(expect.objectContaining({ reason: "protocol" }));
    expect(() =>
      decodeResponse(
        { version: 1, kind: "result", code: 0, ...diagnostic, stdout: "", stderr: "" },
        request,
      ),
    ).toThrow(expect.objectContaining({ reason: "protocol" }));
  });

  test("из cause выбирается только системный код, без message/path/argv/env", () => {
    const cause = new Error("private-token", {
      cause: Object.assign(new Error("private-token"), {
        code: "EACCES",
        path: "/private-token",
        spawnargs: ["private-token"],
        env: { TOKEN: "private-token" },
      }),
    });

    expect(spawnDiagnostic("container-setup", cause)).toEqual({
      stage: "container-setup",
      systemCode: "EACCES",
    });
    expect(spawnDiagnostic("command-spawn", new Error("private-token"))).toEqual({
      stage: "command-spawn",
    });
  });
});
