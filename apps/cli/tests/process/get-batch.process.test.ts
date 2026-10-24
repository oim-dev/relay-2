import { describe, expect, test } from "bun:test";
import { KnowledgeService } from "@relay/core";
import { initializeProject } from "@relay/project-runtime";
import { ProjectDatabase } from "@relay/storage";
import { invokeBinary } from "./cli-process";

/**
 * Создаёт проект и одну запись через Runtime/Core; все соединения закрыты до запуска бинарника.
 */
async function prepareProject(directory: string): Promise<void> {
  const project = initializeProject({
    cwd: directory,
    home: directory,
    name: "Процесс",
    slug: "process",
  });
  const db = ProjectDatabase.open(project.databasePath);
  try {
    await new KnowledgeService(db).create(
      "document",
      { name: "Исходный", body: "# Полный текст\n" },
      "fixture",
    );
  } finally {
    db.close();
  }
}

describe("Потоки get/batch собранного бинарника", () => {
  test("исходный байт FF в JSON stdin отклоняется до выбора проекта без подстановки U+FFFD", async () => {
    const stdin = Buffer.concat([
      Buffer.from(
        '{"version":1,"operations":[{"op":"document.create","input":{"name":"Повреждённый UTF-8","body":"A',
      ),
      new Uint8Array([0xff]),
      Buffer.from('B"}}]}'),
    ]);

    const response = await invokeBinary(
      [
        "batch",
        "--actor",
        "process",
        "--operation-key",
        "invalid-utf8",
        "--input",
        "-",
        "--format",
        "json",
      ],
      {
        stdin,
        artifactGroup: "get-batch/cli-review",
      },
    );

    expect(response.exitCode).toBe(2);
    expect(response.stdout).toBe("");
    expect(JSON.parse(response.stderr)).toMatchObject({
      ok: false,
      error: { code: "INVALID_UTF8" },
    });
    expect(response.files).toEqual([]);
  });

  test("закрытый stdout сохраняет ненулевой код частичного get", async () => {
    const response = await invokeBinary(["get", "DOC-1", "missing"], {
      prepare: prepareProject,
      closeStdout: true,
      artifactGroup: "get-batch",
    });

    expect(response.exitCode).toBe(3);
    expect(response.stdout).toBe("");
    expect(response.stderr).toContain("NOT_FOUND");
  });

  test("stdin более 8 МиБ отклоняется до открытия проекта с кодом ввода", async () => {
    const response = await invokeBinary(["batch", "--check", "--input", "-", "--format", "json"], {
      stdin: "x".repeat(8 * 1024 * 1024 + 1),
      artifactGroup: "get-batch",
    });

    expect(response.exitCode).toBe(2);
    expect(response.stdout).toBe("");
    expect(JSON.parse(response.stderr)).toMatchObject({
      ok: false,
      error: { code: "INPUT_TOO_LARGE" },
    });
    expect(response.files).toEqual([]);
  });

  test("частичный get публикует один JSON в stdout и сохраняет ненулевой код процесса", async () => {
    const response = await invokeBinary(["get", "DOC-1", "missing", "--format", "json"], {
      prepare: prepareProject,
      artifactGroup: "get-batch",
    });

    expect(response.exitCode).toBe(3);
    expect(JSON.parse(response.stdout)).toMatchObject({
      ok: false,
      data: {
        view: "full",
        items: [
          { ref: "DOC-1", ok: true, entity: { data: { body: "# Полный текст\n" } } },
          { ref: "missing", ok: false, error: { code: "NOT_FOUND" } },
        ],
      },
    });
    expect(JSON.parse(response.stderr)).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  test("batch выполняется на корневом узле с подкомандой result и читает настоящий stdin до EOF", async () => {
    const input = {
      version: 1,
      operations: [
        {
          op: "document.create",
          as: "stdin",
          input: { name: "Из stdin", body: "\n## Markdown\n\n  код\n" },
        },
      ],
    };

    const response = await invokeBinary(
      [
        "batch",
        "--actor",
        "process",
        "--operation-key",
        "stdin",
        "--input",
        "-",
        "--return",
        "full",
        "--format",
        "json",
      ],
      { prepare: prepareProject, stdin: JSON.stringify(input), artifactGroup: "get-batch" },
    );

    expect(response.exitCode).toBe(0);
    expect(response.stderr).toBe("");
    expect(JSON.parse(response.stdout)).toMatchObject({
      ok: true,
      data: {
        operationKey: "stdin",
        status: "committed",
        replayed: false,
        items: [{ key: "DOC-2", as: "stdin" }],
        entities: [{ createdBy: "process", data: { body: "\n## Markdown\n\n  код\n" } }],
      },
    });
  });
});
