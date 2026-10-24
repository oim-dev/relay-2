import { describe, expect, test } from "bun:test";
import { GIT_SYNC_REQUEST_MAX_BYTES } from "@relay/contracts";
import { encodeGitSyncRequest } from "./request";
import { createGitSyncClient, decodeGitSyncResponse } from "./client";

const nonJsonValues = [
  {
    name: "Infinity после JSON.parse(1e999)",
    value: JSON.parse("1e999"),
    reason: "non-finite-number",
  },
  { name: "NaN", value: Number.NaN, reason: "non-finite-number" },
  { name: "минус Infinity", value: Number.NEGATIVE_INFINITY, reason: "non-finite-number" },
  { name: "undefined в поле", value: undefined, reason: "undefined" },
  { name: "bigint", value: 1n, reason: "bigint" },
  { name: "symbol", value: Symbol("value"), reason: "symbol" },
  { name: "function", value: Math.abs, reason: "function" },
  { name: "symbol-ключ объекта", value: { [Symbol("key")]: 1 }, reason: "symbol-key" },
  { name: "Date с неявным toJSON", value: new Date(0), reason: "non-json-object" },
  { name: "Map с потерей содержимого", value: new Map([["field", 1]]), reason: "non-json-object" },
  { name: "разреженный массив", value: new Array(2), reason: "sparse-or-extended-array" },
] as const;

describe("Семантика JSON процессного запроса Git Sync", () => {
  test.each([
    {
      name: "успех вместе с error",
      response: {
        version: 1,
        ok: true,
        data: null,
        error: { code: "FAILED", message: "Отказ", exitCode: 4 },
      },
      exitCode: 0,
    },
    {
      name: "ошибка вместе с data",
      response: {
        version: 1,
        ok: false,
        data: null,
        error: { code: "FAILED", message: "Отказ", exitCode: 4 },
      },
      exitCode: 4,
    },
  ])("$name не считается целостным envelope", ({ response, exitCode }) => {
    expect(() => decodeGitSyncResponse(JSON.stringify(response), exitCode, "")).toThrow(
      expect.objectContaining({ code: "GIT_SYNC_PROTOCOL_ERROR" }),
    );
  });

  test.each(nonJsonValues)("$name отклоняется вместо потери значения", ({ value, reason }) => {
    const request = {
      version: 1 as const,
      action: "status",
      options: { cwd: "/fixture" },
      input: { value },
    };

    expect(() => encodeGitSyncRequest(request)).toThrow(
      expect.objectContaining({
        code: "GIT_SYNC_INVALID_REQUEST",
        exitCode: 2,
        details: { path: ["input", "value"], reason },
      }),
    );
  });

  test("цикл отклоняется, общие нециклические поддеревья сохраняются", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const shared = { text: "  Юникод\r\n", empty: "", no: false, missing: null, value: 0 };
    const request = { version: 1 as const, action: "status", options: { cwd: "/fixture" } };

    expect(() => encodeGitSyncRequest({ ...request, input: { cycle } })).toThrow(
      expect.objectContaining({
        code: "GIT_SYNC_INVALID_REQUEST",
        details: { path: ["input", "cycle", "self"], reason: "cycle" },
      }),
    );
    expect(
      JSON.parse(encodeGitSyncRequest({ ...request, input: { first: shared, second: shared } })),
    ).toEqual({ ...request, input: { first: shared, second: shared } });
  });

  test("getters и toJSON не выполняются при отказе", () => {
    let reads = 0;
    const getter = Object.defineProperty({}, "field", {
      enumerable: true,
      /**
       * Счётчик обнаруживает скрытое выполнение вызывающего кода сериализатором.
       */
      get(): number {
        reads++;
        return 1;
      },
    });
    const converter = {
      /**
       * toJSON изменил бы смысл исходного объекта, поэтому его вызов запрещён.
       */
      toJSON(): null {
        reads++;
        return null;
      },
    };
    const request = { version: 1 as const, action: "status", options: { cwd: "/fixture" } };

    expect(() => encodeGitSyncRequest({ ...request, input: { getter } })).toThrow(
      expect.objectContaining({ code: "GIT_SYNC_INVALID_REQUEST" }),
    );
    expect(() => encodeGitSyncRequest({ ...request, input: { converter } })).toThrow(
      expect.objectContaining({ code: "GIT_SYNC_INVALID_REQUEST" }),
    );
    expect(reads).toBe(0);
  });

  test("массив с undefined и игнорируемое stringify свойство не теряются молча", () => {
    const extended = Object.assign([1], { note: "не потерять" });
    const hidden = Object.defineProperty({}, "value", { value: 1 });
    const request = { version: 1 as const, action: "status", options: { cwd: "/fixture" } };

    expect(() => encodeGitSyncRequest({ ...request, input: { items: [undefined] } })).toThrow(
      expect.objectContaining({ code: "GIT_SYNC_INVALID_REQUEST" }),
    );
    expect(() => encodeGitSyncRequest({ ...request, input: { items: extended } })).toThrow(
      expect.objectContaining({ code: "GIT_SYNC_INVALID_REQUEST" }),
    );
    expect(() => encodeGitSyncRequest({ ...request, input: { hidden } })).toThrow(
      expect.objectContaining({ code: "GIT_SYNC_INVALID_REQUEST" }),
    );
  });

  test("ошибка input возникает до version probe и запуска компонента", async () => {
    let calls = 0;
    const client = createGitSyncClient({
      cwd: "/missing",
      env: {},
      userHome: "/missing",
      executablePath: process.execPath,
      binary: process.execPath,
      version: "0.0.0",
      /**
       * Любой запуск, включая --version, означал бы слишком позднюю проверку ввода.
       */
      runner: async (): Promise<never> => {
        calls++;
        throw new Error("Процесс не должен запускаться");
      },
    });

    await expect(
      client.request({
        version: 1,
        action: "conflicts.resolve",
        options: { cwd: "/missing" },
        input: { decision: { value: undefined } },
      }),
    ).rejects.toMatchObject({ code: "GIT_SYNC_INVALID_REQUEST", exitCode: 2 });
    expect(calls).toBe(0);
  });

  test("полный Unicode envelope допускает ровно 16 MiB и отклоняет следующий символ", () => {
    const header =
      '{"version":1,"action":"status","options":{"cwd":"/fixture"},"input":{"text":""}}';
    const payloadBytes = GIT_SYNC_REQUEST_MAX_BYTES - Buffer.byteLength(header, "utf8");
    const text = "я".repeat(Math.floor(payloadBytes / 2)) + (payloadBytes % 2 ? "a" : "");
    const request = {
      version: 1 as const,
      action: "status",
      options: { cwd: "/fixture" },
      input: { text },
    };

    const encoded = encodeGitSyncRequest(request);

    expect(Buffer.byteLength(encoded, "utf8")).toBe(GIT_SYNC_REQUEST_MAX_BYTES);
    expect(JSON.parse(encoded).input.text).toBe(text);
    expect(() => encodeGitSyncRequest({ ...request, input: { text: `${text}я` } })).toThrow(
      expect.objectContaining({
        code: "GIT_SYNC_REQUEST_TOO_LARGE",
        exitCode: 2,
        details: { bytes: GIT_SYNC_REQUEST_MAX_BYTES + 2, maxBytes: GIT_SYNC_REQUEST_MAX_BYTES },
      }),
    );
  });

  test("неfinite значение ответа не превращается в null в последующем CLI JSON", () => {
    expect(() =>
      decodeGitSyncResponse('{"version":1,"ok":true,"data":{"value":1e999}}', 0, ""),
    ).toThrow(expect.objectContaining({ code: "GIT_SYNC_PROTOCOL_ERROR" }));
  });
});
