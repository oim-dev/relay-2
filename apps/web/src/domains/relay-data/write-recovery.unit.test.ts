/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import type { BatchResult, NamedCommand, ServerContext } from "@relay/contracts";
import type { PendingWriteRecovery } from "./relay-data.types";
import { createWriteCommands, UncertainWriteError } from "./write-commands";
import { createWriteHttpClient } from "./testing/write-http";

const context: ServerContext = {
  actor: "Первоначальный автор",
  mode: "project",
  version: "test",
  projects: [],
};
const attachment: NamedCommand[] = [
  {
    op: "document.link",
    ref: "document-a",
    ifRevision: 7,
    expectedVersion: "original-a",
    input: { target: "feature", type: "references", description: "Первый документ" },
  },
  {
    op: "document.link",
    ref: "document-b",
    ifRevision: 11,
    expectedVersion: "original-b",
    input: { target: "feature", type: "references", description: "Второй документ" },
  },
];
const attached: BatchResult = {
  status: "committed",
  replayed: true,
  operationKey: "attach-1",
  items: [
    {
      index: 0,
      op: "document.link",
      as: null,
      id: "document-a",
      kind: "document",
      key: "DOC-1",
      revision: 8,
      owner: { id: "document-a", kind: "document", key: "DOC-1", revision: 8 },
      outputs: [],
    },
    {
      index: 1,
      op: "document.link",
      as: null,
      id: "document-b",
      kind: "document",
      key: "DOC-2",
      revision: 12,
      owner: { id: "document-b", kind: "document", key: "DOC-2", revision: 12 },
      outputs: [],
    },
  ],
  entities: [
    {
      id: "document-a",
      kind: "document",
      key: "DOC-1",
      revision: 8,
      createdBy: "Первоначальный автор",
      updatedBy: "Первоначальный автор",
      createdAt: "2026-10-26T00:00:00.000Z",
      updatedAt: "2026-10-26T00:01:00.000Z",
      data: {
        name: "Первый",
        body: "Исходный текст",
        summary: "",
        documentKind: "description",
        documentStatus: "draft",
        pinned: false,
        sectionId: null,
        relations: [
          {
            target: { kind: "feature", id: "feature" },
            type: "references",
            description: "Первый документ",
          },
        ],
      },
    },
    {
      id: "document-b",
      kind: "document",
      key: "DOC-2",
      revision: 12,
      createdBy: "Первоначальный автор",
      updatedBy: "Первоначальный автор",
      createdAt: "2026-10-26T00:00:00.000Z",
      updatedAt: "2026-10-26T00:01:00.000Z",
      data: {
        name: "Второй",
        body: "Другой текст",
        summary: "",
        documentKind: "description",
        documentStatus: "draft",
        pinned: false,
        sectionId: null,
        relations: [
          {
            target: { kind: "feature", id: "feature" },
            type: "references",
            description: "Второй документ",
          },
        ],
      },
    },
  ],
};

/**
 * Возвращает конкретный предметный отказ вместо произвольного исключения HTTP fixture.
 */
function failure(code: string, status: number): Response {
  return Response.json({ ok: false, error: { code, message: "Отказ HTTP" } }, { status });
}

describe("Восстановление записи после ухода из исходной формы", () => {
  test("после unmount receipt возвращает первоначальный результат без второго POST и освобождает проект", async () => {
    const calls: string[] = [];
    const bodies: unknown[] = [];
    const writer = createWriteCommands(
      createWriteHttpClient(async (request) => {
        const url = new URL(request.url);
        calls.push(`${request.method} ${url.pathname}${url.search}`);
        if (url.pathname === "/api/v2/context") {
          return Response.json({ ok: true, data: context });
        }
        if (request.method === "POST") {
          bodies.push(await request.json());
          if (bodies.length === 1) {
            throw new TypeError("Ответ после commit потерян");
          }
          return Response.json({
            ok: true,
            data: { ...attached, operationKey: "next", replayed: false },
          });
        }
        return Response.json({ ok: true, data: attached });
      }),
    );
    const notices: (PendingWriteRecovery | null)[] = [];
    const unsubscribe = writer.subscribePendingWrite("project", () =>
      notices.push(writer.getPendingWrite("project")),
    );
    try {
      await expect(
        writer("project", structuredClone(attachment), "attach-1"),
      ).rejects.toBeInstanceOf(UncertainWriteError);
    } finally {
      unsubscribe(); // Исходная форма и её подписка ушли; новый экран не знает selected/CAS.
    }
    const pending = writer.getPendingWrite("project");
    expect(pending).toEqual({ operationKey: "attach-1", recovering: false });
    expect(writer.getPendingWrite("project")).toBe(pending);

    const recovered = await writer.recoverPendingWrite("project", "attach-1");

    expect(recovered).toEqual(attached);
    expect(recovered?.entities.map((entity) => entity.revision)).toEqual([8, 12]);
    expect(calls).toEqual([
      "GET /api/v2/context",
      "POST /api/v2/projects/project/batch",
      "GET /api/v2/projects/project/receipts?operationKey=attach-1",
    ]);
    expect(writer.getPendingWrite("project")).toBeNull();
    expect(notices).toEqual([{ operationKey: "attach-1", recovering: false }]);

    await writer(
      "project",
      [
        {
          op: "document.link",
          ref: "document-a",
          ifRevision: 8,
          input: { target: "other-feature", type: "references", description: "Новая запись" },
        },
      ],
      "next",
    );

    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual({
      actor: "Первоначальный автор",
      operationKey: "next",
      commands: [
        {
          op: "document.link",
          ref: "document-a",
          ifRevision: 8,
          input: { target: "other-feature", type: "references", description: "Новая запись" },
        },
      ],
    });
  });

  test("NOT_FOUND разрешает только frozen batch с первоначальными actor/key/CAS, а не изменённый выбор", async () => {
    const bodies: unknown[] = [];
    const calls: string[] = [];
    const writer = createWriteCommands(
      createWriteHttpClient(async (request) => {
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
          throw new TypeError("Запрос не дошёл до commit");
        }
        return Response.json({ ok: true, data: { ...attached, replayed: false } });
      }),
    );
    await expect(writer("project", structuredClone(attachment), "attach-1")).rejects.toMatchObject({
      code: "UNRESOLVED_OPERATION",
    });
    await expect(
      writer(
        "project",
        [
          {
            op: "document.link",
            ref: "new-selection",
            ifRevision: 99,
            input: { target: "other-feature" },
          },
        ],
        "changed-key",
      ),
    ).rejects.toMatchObject({ code: "UNRESOLVED_OPERATION" });

    const recovered = await writer.recoverPendingWrite("project", "attach-1");

    expect(recovered).toEqual({ ...attached, replayed: false });
    expect(bodies).toEqual([
      { actor: "Первоначальный автор", operationKey: "attach-1", commands: attachment },
      { actor: "Первоначальный автор", operationKey: "attach-1", commands: attachment },
    ]);
    expect(calls).toEqual([
      "/api/v2/context",
      "/api/v2/projects/project/batch",
      "/api/v2/projects/project/receipts",
      "/api/v2/projects/project/batch",
    ]);
    expect(writer.getPendingWrite("project")).toBeNull();
  });

  test("два recovery и повтор формы разделяют одну receipt и публикуют recovering до подтверждения", async () => {
    const gate = Promise.withResolvers<void>();
    let receipts = 0;
    const writer = createWriteCommands(
      createWriteHttpClient(async (request) => {
        if (new URL(request.url).pathname === "/api/v2/context") {
          return Response.json({ ok: true, data: context });
        }
        if (request.method === "POST") {
          throw new TypeError("Ответ потерян");
        }
        receipts++;
        await gate.promise;
        return Response.json({ ok: true, data: attached });
      }),
    );
    const notices: (PendingWriteRecovery | null)[] = [];
    const unsubscribe = writer.subscribePendingWrite("project", () =>
      notices.push(writer.getPendingWrite("project")),
    );
    try {
      await expect(writer("project", attachment, "attach-1")).rejects.toMatchObject({
        code: "UNRESOLVED_OPERATION",
      });

      const first = writer.recoverPendingWrite("project", "attach-1");
      const second = writer.recoverPendingWrite("project", "attach-1");
      const originalForm = writer("project", attachment, "new-form-key");
      expect(writer.getPendingWrite("project")).toEqual({
        operationKey: "attach-1",
        recovering: true,
      });
      gate.resolve();
      const results = await Promise.all([first, second, originalForm]);

      expect(results).toEqual([attached, attached, attached]);
      expect(receipts).toBe(1);
      expect(notices).toEqual([
        { operationKey: "attach-1", recovering: false },
        { operationKey: "attach-1", recovering: true },
        null,
      ]);
    } finally {
      gate.resolve();
      unsubscribe();
    }
  });

  test("обычный первый submit не создаёт recovery alert и чтение/подписка не делают I/O", async () => {
    const gate = Promise.withResolvers<void>();
    const postStarted = Promise.withResolvers<void>();
    const calls: string[] = [];
    const writer = createWriteCommands(
      createWriteHttpClient(async (request) => {
        const path = new URL(request.url).pathname;
        calls.push(path);
        if (path === "/api/v2/context") {
          return Response.json({ ok: true, data: context });
        }
        postStarted.resolve();
        await gate.promise;
        return Response.json({ ok: true, data: { ...attached, replayed: false } });
      }),
    );
    let notices = 0;
    const unsubscribe = writer.subscribePendingWrite("project", () => {
      notices++;
    });
    try {
      expect(writer.getPendingWrite("project")).toBeNull();
      expect(calls).toHaveLength(0);
      const first = writer("project", attachment, "attach-1");
      await postStarted.promise;
      expect(writer.getPendingWrite("project")).toBeNull();

      const recovery = writer.recoverPendingWrite("project", "attach-1");
      gate.resolve();
      await first;

      expect(await recovery).toBeNull();
      expect(calls).toEqual(["/api/v2/context", "/api/v2/projects/project/batch"]);
      expect(writer.getPendingWrite("project")).toBeNull();
      expect(notices).toBe(0);
    } finally {
      gate.resolve();
      unsubscribe();
    }
  });

  test.each([
    { name: "недоступный сервер", status: 503, code: "UNAVAILABLE" },
    { name: "посторонний 404", status: 404, code: "PROJECT_UNAVAILABLE" },
  ])(
    "$name при recovery сохраняет исходную неопределённость без повторного POST",
    async ({ status, code }) => {
      let posts = 0;
      const writer = createWriteCommands(
        createWriteHttpClient((request) => {
          if (new URL(request.url).pathname === "/api/v2/context") {
            return Response.json({ ok: true, data: context });
          }
          if (request.method === "POST") {
            posts++;
            throw new TypeError("Ответ потерян");
          }
          return failure(code, status);
        }),
      );
      await expect(writer("project", attachment, "attach-1")).rejects.toMatchObject({
        code: "UNRESOLVED_OPERATION",
      });

      await expect(writer.recoverPendingWrite("project", "attach-1")).rejects.toMatchObject({
        code: "UNRESOLVED_OPERATION",
      });

      expect(writer.getPendingWrite("project")).toEqual({
        operationKey: "attach-1",
        recovering: false,
      });
      expect(posts).toBe(1);
    },
  );

  test("достоверный конфликт frozen повтора снимает recovery без подстановки свежего CAS", async () => {
    const bodies: unknown[] = [];
    const writer = createWriteCommands(
      createWriteHttpClient(async (request) => {
        if (new URL(request.url).pathname === "/api/v2/context") {
          return Response.json({ ok: true, data: context });
        }
        if (request.method === "GET") {
          return failure("NOT_FOUND", 404);
        }
        bodies.push(await request.json());
        if (bodies.length === 1) {
          throw new TypeError("Ответ потерян");
        }
        return failure("REVISION_CONFLICT", 409);
      }),
    );
    await expect(writer("project", attachment, "attach-1")).rejects.toMatchObject({
      code: "UNRESOLVED_OPERATION",
    });

    await expect(writer.recoverPendingWrite("project", "attach-1")).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
      status: 409,
    });

    expect(writer.getPendingWrite("project")).toBeNull();
    expect(bodies).toEqual([
      { actor: "Первоначальный автор", operationKey: "attach-1", commands: attachment },
      { actor: "Первоначальный автор", operationKey: "attach-1", commands: attachment },
    ]);
  });

  test("другой origin/project и устаревший ключ уведомления не восстанавливают чужую операцию", async () => {
    let origin = "https://first.test";
    const receipts: string[] = [];
    const writer = createWriteCommands(
      createWriteHttpClient((request) => {
        const url = new URL(request.url);
        if (url.pathname === "/api/v2/context") {
          return Response.json({ ok: true, data: context });
        }
        if (request.method === "POST") {
          throw new TypeError("Ответ потерян");
        }
        receipts.push(`${origin}${url.pathname}${url.search}`);
        return Response.json({
          ok: true,
          data: { ...attached, operationKey: url.searchParams.get("operationKey") },
        });
      }),
      () => origin,
    );
    await expect(writer("project-a", attachment, "first-a")).rejects.toMatchObject({
      code: "UNRESOLVED_OPERATION",
    });
    await expect(writer("project-b", attachment, "first-b")).rejects.toMatchObject({
      code: "UNRESOLVED_OPERATION",
    });
    origin = "https://second.test";
    await expect(writer("project-a", attachment, "second-a")).rejects.toMatchObject({
      code: "UNRESOLVED_OPERATION",
    });

    expect(await writer.recoverPendingWrite("project-a", "first-a")).toBeNull();
    origin = "https://first.test";
    expect(await writer.recoverPendingWrite("project-b", "first-a")).toBeNull();
    const result = await writer.recoverPendingWrite("project-a", "first-a");

    expect(result?.operationKey).toBe("first-a");
    expect(writer.getPendingWrite("project-a")).toBeNull();
    expect(writer.getPendingWrite("project-b")).toEqual({
      operationKey: "first-b",
      recovering: false,
    });
    await expect(writer("project-a", attachment, "next-a")).rejects.toMatchObject({
      code: "UNRESOLVED_OPERATION",
    });
    expect(await writer.recoverPendingWrite("project-a", "first-a")).toBeNull();
    expect(writer.getPendingWrite("project-a")).toEqual({
      operationKey: "next-a",
      recovering: false,
    });
    origin = "https://second.test";
    expect(writer.getPendingWrite("project-a")).toEqual({
      operationKey: "second-a",
      recovering: false,
    });
    expect(receipts).toEqual([
      "https://first.test/api/v2/projects/project-a/receipts?operationKey=first-a",
    ]);
  });
});
