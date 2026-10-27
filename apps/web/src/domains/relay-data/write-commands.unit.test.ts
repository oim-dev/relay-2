/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import type { BatchResult, NamedCommand, ServerContext } from "@relay/contracts";
import { createWriteHttpClient as httpClient } from "./testing/write-http";
import { createWriteCommands, UncertainWriteError } from "./write-commands";

const context: ServerContext = {
  actor: "Исходный автор",
  mode: "project",
  version: "0.0.0",
  projects: [{ id: "project", name: "Проект", slug: "project", available: true }],
};
const committed: BatchResult = {
  operationKey: "write-1",
  status: "committed",
  replayed: false,
  items: [
    {
      index: 0,
      op: "document.update",
      as: null,
      id: "doc",
      kind: "document",
      key: "DOC-1",
      revision: 8,
      owner: { id: "doc", kind: "document", key: "DOC-1", revision: 8 },
      outputs: [],
    },
  ],
  entities: [
    {
      id: "doc",
      kind: "document",
      key: "DOC-1",
      revision: 8,
      createdAt: "2026-10-26T00:00:00.000Z",
      updatedAt: "2026-10-26T00:01:00.000Z",
      createdBy: "Исходный автор",
      updatedBy: "Исходный автор",
      data: {
        name: "Документ",
        body: "Первоначальная запись",
        summary: "",
        sectionId: null,
        pinned: false,
        documentKind: "specification",
        documentStatus: "draft",
        relations: [],
      },
    },
  ],
};

/**
 * Создаёт свежий изменяемый ввод, чтобы обнаружить позднее копирование guard и Markdown.
 */
function documentCommand(): NamedCommand {
  return {
    op: "document.update",
    ref: "doc",
    ifRevision: 7,
    expectedVersion: "initial-token",
    input: { body: "Первоначальная запись" },
  };
}

/**
 * Возвращает предметный отказ HTTP, не подменяя его произвольным исключением callback.
 */
function failure(code: string, status: number): Response {
  return Response.json({ ok: false, error: { code, message: "Отказ сервера" } }, { status });
}

describe("Замороженные записи Web через REST SDK", () => {
  test("параллельные вызовы делят context и POST, а изменение аргумента не меняет исходный guard", async () => {
    const releaseContext = Promise.withResolvers<void>();
    const calls: string[] = [];
    const bodies: unknown[] = [];
    const write = createWriteCommands(
      httpClient(async (request) => {
        const path = new URL(request.url).pathname;
        calls.push(path);
        if (path === "/api/v2/context") {
          await releaseContext.promise;
          return Response.json({ ok: true, data: context });
        }
        bodies.push(await request.json());
        return Response.json({ ok: true, data: committed });
      }),
    );
    const command = {
      ...documentCommand(),
      ifRevision: 7,
      input: { body: "Первоначальная запись" },
    };
    const original = structuredClone(command);

    const first = write("project", [command], "write-1");
    const second = write("project", [original], "new-form-key");
    command.input.body = "Чужой ввод после начала запроса";
    command.ifRevision = 99;
    releaseContext.resolve();
    const results = await Promise.all([first, second]);

    expect(calls).toEqual(["/api/v2/context", "/api/v2/projects/project/batch"]);
    expect(bodies).toEqual([
      { actor: "Исходный автор", operationKey: "write-1", commands: [original] },
    ]);
    expect(results).toEqual([committed, committed]);
  });

  test.each([
    { name: "сетевой обрыв", status: 0 },
    { name: "ответ 503", status: 503 },
    { name: "повреждённый JSON 200", status: 200 },
  ])(
    "$name после возможного commit восстанавливается receipt без второго POST",
    async ({ status }) => {
      const calls: string[] = [];
      const replay = { ...committed, replayed: true };
      const write = createWriteCommands(
        httpClient((request) => {
          const url = new URL(request.url);
          calls.push(`${request.method} ${url.pathname}${url.search}`);
          if (url.pathname === "/api/v2/context") {
            return Response.json({ ok: true, data: context });
          }
          if (request.method === "POST") {
            // Сервер уже мог сохранить данные: HTTP boundary теряет только ответ.
            if (status === 0) {
              throw new TypeError("Соединение закрыто после commit");
            }
            return status === 200
              ? new Response("incomplete json")
              : failure("UNAVAILABLE", status);
          }
          return Response.json({ ok: true, data: replay });
        }),
      );
      await expect(write("project", [documentCommand()], "write-1")).rejects.toBeInstanceOf(
        UncertainWriteError,
      );

      const result = await write("project", [documentCommand()], "new-form-key");

      expect(result).toEqual(replay);
      expect(result.entities[0]).toMatchObject({
        revision: 8,
        data: { body: "Первоначальная запись" },
      });
      expect(calls).toEqual([
        "GET /api/v2/context",
        "POST /api/v2/projects/project/batch",
        "GET /api/v2/projects/project/receipts?operationKey=write-1",
      ]);
    },
  );

  test("обрыв до commit и NOT_FOUND повторяют исходные команды, автора и ключ без обновления CAS", async () => {
    const bodies: unknown[] = [];
    const calls: string[] = [];
    const write = createWriteCommands(
      httpClient(async (request) => {
        const path = new URL(request.url).pathname;
        calls.push(path);
        if (path === "/api/v2/context") {
          return Response.json({ ok: true, data: context });
        }
        if (request.method === "GET") {
          return failure("NOT_FOUND", 404);
        }
        bodies.push(await request.json());
        if (bodies.length === 1) {
          throw new TypeError("Соединение закрыто до commit");
        }
        return Response.json({ ok: true, data: committed });
      }),
    );
    await expect(write("project", [documentCommand()], "write-1")).rejects.toMatchObject({
      code: "UNRESOLVED_OPERATION",
    });

    const result = await write("project", [documentCommand()], "new-form-key");

    expect(result).toEqual(committed);
    expect(bodies).toEqual([
      { actor: "Исходный автор", operationKey: "write-1", commands: [documentCommand()] },
      { actor: "Исходный автор", operationKey: "write-1", commands: [documentCommand()] },
    ]);
    expect(calls).toEqual([
      "/api/v2/context",
      "/api/v2/projects/project/batch",
      "/api/v2/projects/project/receipts",
      "/api/v2/projects/project/batch",
    ]);
  });

  test("изменённый ввод до ответа context не запускает вторую запись", async () => {
    const gate = Promise.withResolvers<void>();
    const bodies: unknown[] = [];
    const write = createWriteCommands(
      httpClient(async (request) => {
        if (new URL(request.url).pathname === "/api/v2/context") {
          await gate.promise;
          return Response.json({ ok: true, data: context });
        }
        bodies.push(await request.json());
        return Response.json({ ok: true, data: committed });
      }),
    );

    const first = write("project", [documentCommand()], "write-1");
    const changed = write(
      "project",
      [{ ...documentCommand(), ifRevision: 9, input: { body: "Новый ввод" } }],
      "other",
    ).catch((error: unknown) => error);
    gate.resolve();
    const [saved, error] = await Promise.all([first, changed]);

    expect(saved).toEqual(committed);
    expect(error).toBeInstanceOf(UncertainWriteError);
    expect(bodies).toEqual([
      { actor: "Исходный автор", operationKey: "write-1", commands: [documentCommand()] },
    ]);
  });

  test("изменённый ввод после обрыва не заменяет первоначальную запись", async () => {
    const bodies: unknown[] = [];
    const write = createWriteCommands(
      httpClient(async (request) => {
        if (new URL(request.url).pathname === "/api/v2/context") {
          return Response.json({ ok: true, data: context });
        }
        bodies.push(await request.json());
        throw new TypeError("Нет ответа");
      }),
    );
    await expect(write("project", [documentCommand()], "write-1")).rejects.toMatchObject({
      code: "UNRESOLVED_OPERATION",
    });

    await expect(
      write(
        "project",
        [{ ...documentCommand(), ifRevision: 9, input: { body: "Новый ввод" } }],
        "other",
      ),
    ).rejects.toMatchObject({ code: "UNRESOLVED_OPERATION" });

    expect(bodies).toEqual([
      { actor: "Исходный автор", operationKey: "write-1", commands: [documentCommand()] },
    ]);
  });

  test("смена состава batch не обходит блокировку предыдущей записи проекта", async () => {
    let posts = 0;
    const write = createWriteCommands(
      httpClient((request) => {
        if (new URL(request.url).pathname === "/api/v2/context") {
          return Response.json({ ok: true, data: context });
        }
        posts++;
        throw new TypeError("Неизвестен исход пакета");
      }),
    );
    await expect(write("project", [documentCommand()], "write-1")).rejects.toMatchObject({
      code: "UNRESOLVED_OPERATION",
    });

    await expect(
      write(
        "project",
        [documentCommand(), { op: "document.create", input: { name: "Добавленное действие" } }],
        "changed-key",
      ),
    ).rejects.toMatchObject({ code: "UNRESOLVED_OPERATION" });

    expect(posts).toBe(1);
  });

  test.each([
    { name: "503", code: "UNAVAILABLE", status: 503 },
    { name: "посторонний 404", code: "PROJECT_UNAVAILABLE", status: 404 },
    { name: "невалидный JSON 200", code: null, status: 200 },
  ])("отказ чтения receipt: $name не разрешает повторную запись", async ({ code, status }) => {
    let posts = 0;
    let receipts = 0;
    const write = createWriteCommands(
      httpClient((request) => {
        if (new URL(request.url).pathname === "/api/v2/context") {
          return Response.json({ ok: true, data: context });
        }
        if (request.method === "POST") {
          posts++;
          throw new TypeError("Ответ потерян");
        }
        receipts++;
        return code === null ? new Response("not json") : failure(code, status);
      }),
    );
    await expect(write("project", [documentCommand()], "write-1")).rejects.toMatchObject({
      code: "UNRESOLVED_OPERATION",
    });

    await expect(write("project", [documentCommand()])).rejects.toMatchObject({
      code: "UNRESOLVED_OPERATION",
    });
    await expect(write("project", [documentCommand()])).rejects.toMatchObject({
      code: "UNRESOLVED_OPERATION",
    });

    expect(posts).toBe(1);
    expect(receipts).toBe(2);
  });

  test("достоверный REVISION_CONFLICT освобождает операцию и не подставляет свежий guard", async () => {
    const bodies: unknown[] = [];
    const write = createWriteCommands(
      httpClient(async (request) => {
        if (new URL(request.url).pathname === "/api/v2/context") {
          return Response.json({ ok: true, data: context });
        }
        bodies.push(await request.json());
        return bodies.length === 1
          ? failure("REVISION_CONFLICT", 409)
          : Response.json({ ok: true, data: committed });
      }),
    );

    await expect(write("project", [documentCommand()], "write-1")).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
      status: 409,
    });
    const revised = {
      ...documentCommand(),
      ifRevision: 9,
      input: { body: "Явное решение пользователя" },
    };
    await write("project", [revised], "write-2");

    expect(bodies).toEqual([
      { actor: "Исходный автор", operationKey: "write-1", commands: [documentCommand()] },
      { actor: "Исходный автор", operationKey: "write-2", commands: [revised] },
    ]);
  });

  test("одинаковые адреса разных проектов и origin не используют чужую незавершённую запись", async () => {
    let origin = "https://first.test";
    const writes: string[] = [];
    const receiptPaths: string[] = [];
    const write = createWriteCommands(
      httpClient((request) => {
        const path = new URL(request.url).pathname;
        if (path === "/api/v2/context") {
          return Response.json({ ok: true, data: context });
        }
        if (request.method === "POST") {
          writes.push(`${origin}:${path}`);
          throw new TypeError("Нет ответа");
        }
        receiptPaths.push(`${origin}:${path}`);
        return Response.json({ ok: true, data: { ...committed, replayed: true } });
      }),
      () => origin,
    );
    await expect(write("first", [documentCommand()], "write-1")).rejects.toMatchObject({
      code: "UNRESOLVED_OPERATION",
    });

    await expect(write("second", [documentCommand()], "write-2")).rejects.toMatchObject({
      code: "UNRESOLVED_OPERATION",
    });
    origin = "https://second.test";
    await expect(write("first", [documentCommand()], "write-3")).rejects.toMatchObject({
      code: "UNRESOLVED_OPERATION",
    });
    origin = "https://first.test";
    await write("first", [documentCommand()]);

    expect(writes).toEqual([
      "https://first.test:/api/v2/projects/first/batch",
      "https://first.test:/api/v2/projects/second/batch",
      "https://second.test:/api/v2/projects/first/batch",
    ]);
    expect(receiptPaths).toEqual(["https://first.test:/api/v2/projects/first/receipts"]);
  });
});
