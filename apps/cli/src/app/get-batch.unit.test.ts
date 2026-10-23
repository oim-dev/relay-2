import { describe, expect, spyOn, test } from "bun:test";
import { ProjectDatabase } from "@relay/storage";
import { invokeIsolatedCli as invoke } from "../../tests/helpers/help";

const invalidCalls = [
  { name: "batch без входа", argv: ["batch"] },
  { name: "применение без operation key", argv: ["batch", "--input", "-"] },
  { name: "batch с запрещённым input-file", argv: ["batch", "--input-file", "-", "--check"] },
  {
    name: "batch с неизвестным представлением",
    argv: ["batch", "--input", "-", "--check", "--return", "summary"],
  },
  { name: "квитанция без ключа", argv: ["batch", "result"] },
] as const;
const autonomousCalls = [
  { name: "полное чтение", argv: ["get", "--help"] },
  { name: "пакет со stdin", argv: ["batch", "--input", "-", "--help"] },
  { name: "версия вместо применения", argv: ["batch", "--input", "-", "--version"] },
  { name: "квитанция", argv: ["batch", "result", "--help"] },
] as const;
const invalidReadSizes = [
  { name: "пустой get", refs: [] },
  { name: "пустой get после --", refs: ["--"] },
  { name: "201 адрес до --", refs: Array.from({ length: 201 }, () => "PROJECT") },
  { name: "201 адрес после --", refs: ["--", ...Array.from({ length: 201 }, () => "PROJECT")] },
  {
    name: "201 адрес суммарно по обе стороны --",
    refs: [
      ...Array.from({ length: 100 }, () => "PROJECT"),
      "--",
      ...Array.from({ length: 101 }, () => "PROJECT"),
    ],
  },
] as const;

describe("Разбор get/batch без проекта", () => {
  test.each(invalidReadSizes)(
    "$name отклоняется до открытия БД с адресом справки",
    async ({ refs }) => {
      const open = spyOn(ProjectDatabase, "open");
      try {
        const response = await invoke(["get", "--format=json", ...refs]);

        expect(response.exitCode).toBe(2);
        expect(response.stdout).toBe("");
        expect(JSON.parse(response.stderr)).toMatchObject({
          ok: false,
          error: { code: "INVALID_ARGUMENT", helpCommand: "relay get --help" },
        });
        expect(open).not.toHaveBeenCalled();
      } finally {
        open.mockRestore();
      }
    },
  );

  test("--check требует автора до выбора проекта", async () => {
    const response = await invoke(["batch", "--check", "--input", "{}", "--format", "json"]);

    expect(response.exitCode).toBe(2);
    expect(response.stdout).toBe("");
    expect(JSON.parse(response.stderr)).toMatchObject({
      ok: false,
      error: { code: "ACTOR_REQUIRED" },
    });
  });

  test.each(invalidCalls)("$name отклоняется до чтения stdin", async ({ argv }) => {
    const response = await invoke([...argv, "--format", "json"]);

    expect(response.exitCode).toBe(2);
    expect(response.stdout).toBe("");
    expect(JSON.parse(response.stderr)).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENT" },
    });
    expect(response.stderr).not.toContain("INPUT_READ_FAILED");
  });

  test.each(autonomousCalls)("$name доступны без БД и чтения stdin", async ({ argv }) => {
    const response = await invoke(argv);

    expect(response.exitCode).toBe(0);
    expect(response.stderr).toBe("");
    expect(response.stdout).not.toBe("");
  });

  test("корневая справка batch содержит mixed JSON, общий протокол и навигацию без каталога полей", async () => {
    const response = await invoke(["batch", "--help"]);

    expect(response.stdout).toContain("document.create");
    expect(response.stdout).toContain("relay batch help");
    expect(response.stdout).toContain("relay batch help plan stage create");
    expect(response.stdout).not.toContain("task.move");
    expect(response.stdout).not.toContain("    stageId:");
    expect(response.stdout).toContain("8 МиБ");
    expect(response.stdout).toContain("--check");
    expect(response.stdout).toContain("--operation-key");
    expect(response.stdout).toContain("Ошибка записи stdout после commit не отменяет сохранение");
    expect(response.stdout).toContain(
      "пробелы вне JSON-строк и порядок полей объектов несущественны",
    );
    expect(response.stdout).toContain(
      "Автор входит в идентичность запроса; --format и --return не входят",
    );
    expect(response.stdout).toContain('{"$ref":"имя"}');
    expect(response.stdout).toContain('{"$revision":"имя"}');
    expect(response.stdout).not.toContain("--input-file");
    const example = response.stdout.match(/--input '([\s\S]*?)'/)?.[1];
    expect(typeof example).toBe("string");
    expect(JSON.parse(example ?? "")).toMatchObject({
      version: 1,
      operations: [
        { op: "document.create", as: "new-spec" },
        { op: "document.update", ref: "DOC-1", ifRevision: 3 },
      ],
    });
  });

  test("справка get объясняет полный режим по умолчанию, список и частичный результат", async () => {
    const response = await invoke(["get", "--help"]);

    expect(response.stdout).toContain("По умолчанию записи полные");
    expect(response.stdout).toContain("--summary");
    expect(response.stdout).toContain("1 до 200");
    expect(response.stdout).toContain("ok: false");
    expect(response.stdout).not.toContain("--full");
  });
});
