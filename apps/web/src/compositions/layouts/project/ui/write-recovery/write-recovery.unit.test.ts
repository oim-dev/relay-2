/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import type { BatchResult } from "@relay/contracts";
import { getPendingWrite, recoverPendingWrite, writeCommands } from "domains/relay-data";
import { withAdapterHttp } from "domains/relay-data/testing/adapter-http";
import type { WriteRecoveryEffects } from "./types/write-recovery-props.type";
import { isRecoveryProjectKey, recoverWriteNotification } from "./write-recovery";

const command = {
  op: "document.update",
  ref: "document",
  ifRevision: 7,
  input: { body: "Сохранённый текст" },
};
const receipt: BatchResult = {
  operationKey: "original",
  status: "committed",
  replayed: true,
  items: [
    {
      index: 0,
      op: "document.update",
      as: null,
      id: "document",
      kind: "document",
      key: "DOC-1",
      revision: 8,
      owner: { id: "document", kind: "document", key: "DOC-1", revision: 8 },
      outputs: [],
    },
  ],
  entities: [
    {
      id: "document",
      kind: "document",
      key: "DOC-1",
      revision: 8,
      createdBy: "Автор сервера",
      updatedBy: "Автор сервера",
      createdAt: "2026-10-26T00:00:00.000Z",
      updatedAt: "2026-10-26T00:01:00.000Z",
      data: {
        name: "Документ",
        body: "Сохранённый текст",
        summary: "",
        pinned: false,
        sectionId: null,
        documentKind: "description",
        documentStatus: "draft",
        relations: [],
      },
    },
  ],
};

/**
 * Подтверждает заранее подготовленную receipt именно запрошенного ключа, без вычисления эффекта.
 */
function receiptResponse(request: Request): Response {
  return Response.json({
    ok: true,
    data: { ...receipt, operationKey: new URL(request.url).searchParams.get("operationKey") },
  });
}

/**
 * Записывает только эффекты уведомления; настоящий writer/SDK исполняются в каждом сценарии.
 * isActive моделирует срок жизни экземпляра каркаса, refresh — отдельную SWR-границу чтения.
 */
function feedback(
  refresh: WriteRecoveryEffects["refresh"],
  isActive: () => boolean = () => true,
): {
  /* Видимые эффекты в порядке вызова. */
  events: string[];
  /* Узкий интерфейс эффектов уже существующего уведомления. */
  effects: WriteRecoveryEffects;
} {
  const events: string[] = [];
  return {
    events,
    effects: {
      isActive,
      /**
       * Фиксирует начало актуального нажатия, не создавая сетевой запрос.
       */
      started: (): void => {
        events.push("started");
      },
      /**
       * Сохраняет границу чтения отдельно от результата записи.
       */
      refresh: async (matches): Promise<unknown> => {
        events.push("refresh");
        return refresh(matches);
      },
      /**
       * Отмечает подтверждение только исходной операции.
       */
      confirmed: (): void => {
        events.push("confirmed");
      },
      /**
       * Сохраняет конкретную диагностику достоверного отказа.
       */
      rejected: (message): void => {
        events.push(`rejected:${message}`);
      },
      /**
       * Сохраняет диагностику ещё неопределённой операции.
       */
      uncertain: (message): void => {
        events.push(`uncertain:${message}`);
      },
    },
  };
}

describe("Recovery-уведомление выбранного проекта", () => {
  test.each([
    { name: "обычный ключ своего проекта", key: ["document", "project-a", "doc"], expected: true },
    {
      name: "ключ графа с явным origin",
      key: ["relations", "https://relay.test", "project-a", {}],
      expected: true,
    },
    {
      name: "ID совпал с ref чужого проекта",
      key: ["document", "project-b", "project-a"],
      expected: false,
    },
    {
      name: "тот же ID на другом origin",
      key: ["relations", "https://other.test", "project-a", {}],
      expected: false,
    },
    { name: "ключ другого проекта", key: ["document", "project-b", "doc"], expected: false },
    { name: "непроектный строковый ключ", key: "project-a", expected: false },
  ])("$name имеет правильную область инвалидирования", ({ key, expected }) => {
    const matches = isRecoveryProjectKey(key, "project-a", "https://relay.test");

    expect(matches).toBe(expected);
  });

  test("ошибка GET после receipt не превращает подтверждённую запись в отказ", async () => {
    const project = "recovery-ui-get-error";
    const selected: unknown[] = [];
    const observed = feedback(async (matches) => {
      selected.push(
        ...[
          ["document", project, "doc"],
          ["relations", "https://relay.test", project],
          ["document", "other-project", project],
          ["relations", "https://other.test", project],
        ].filter(matches),
      );
      throw new Error("GET недоступен после commit");
    });

    const transport = await withAdapterHttp(
      (request) => {
        if (request.method === "POST") {
          throw new TypeError("Ответ commit потерян");
        }
        return receiptResponse(request);
      },
      async () => {
        await expect(writeCommands(project, [command], "original")).rejects.toMatchObject({
          code: "UNRESOLVED_OPERATION",
        });
        await recoverWriteNotification(project, "original", "https://relay.test", observed.effects);
      },
    );

    expect(observed.events).toEqual(["started", "refresh", "confirmed"]);
    expect(selected).toEqual([
      ["document", project, "doc"],
      ["relations", "https://relay.test", project],
    ]);
    expect(getPendingWrite(project)).toBeNull();
    expect(transport.requests.map((request) => request.method)).toEqual(["GET", "POST", "GET"]);
  });

  test("пустой pending и устаревшая кнопка не показывают подтверждение и не обновляют кеш", async () => {
    const project = "recovery-ui-stale";
    const observed = feedback(async () => undefined);

    const transport = await withAdapterHttp(
      (request) => {
        if (request.method === "POST") {
          throw new TypeError("Ответ потерян");
        }
        return receiptResponse(request);
      },
      async () => {
        await recoverWriteNotification(project, "missing", "https://relay.test", observed.effects);
        await expect(writeCommands(project, [command], "current")).rejects.toMatchObject({
          code: "UNRESOLVED_OPERATION",
        });
        try {
          await recoverWriteNotification(project, "stale", "https://relay.test", observed.effects);
          expect(getPendingWrite(project)).toEqual({ operationKey: "current", recovering: false });
          expect(observed.events).toEqual([]);
        } finally {
          await recoverPendingWrite(project, "current");
        }
      },
    );

    expect(
      transport.requests.map((request) => new URL(request.url).searchParams.get("operationKey")),
    ).toEqual([null, null, "current"]);
  });

  test("после ухода из проекта позднее подтверждение обновляет только его кеш, но не показывает уведомление", async () => {
    const project = "recovery-ui-left";
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let active = true;
    const selected: unknown[] = [];
    const observed = feedback(
      async (matches) => {
        selected.push(
          ...[
            ["document", project],
            ["document", "new-project"],
          ].filter(matches),
        );
      },
      () => active,
    );

    await withAdapterHttp(
      async (request) => {
        if (request.method === "POST") {
          throw new TypeError("Ответ потерян");
        }
        started.resolve();
        await release.promise;
        return receiptResponse(request);
      },
      async () => {
        await expect(writeCommands(project, [command], "original")).rejects.toMatchObject({
          code: "UNRESOLVED_OPERATION",
        });
        const pending = recoverWriteNotification(
          project,
          "original",
          "https://relay.test",
          observed.effects,
        );
        await started.promise;
        active = false;
        release.resolve();
        await pending;
      },
    );

    expect(observed.events).toEqual(["started", "refresh"]);
    expect(selected).toEqual([["document", project]]);
    expect(getPendingWrite(project)).toBeNull();
  });

  test("новая pending во время GET не скрывается поздним подтверждением прежней записи", async () => {
    const project = "recovery-ui-new-pending";
    const observed = feedback(async () => {
      await expect(
        writeCommands(project, [{ ...command, ifRevision: 8 }], "next"),
      ).rejects.toMatchObject({ code: "UNRESOLVED_OPERATION" });
    });

    await withAdapterHttp(
      (request) => {
        if (request.method === "POST") {
          throw new TypeError("Ответ потерян");
        }
        return receiptResponse(request);
      },
      async () => {
        await expect(writeCommands(project, [command], "original")).rejects.toMatchObject({
          code: "UNRESOLVED_OPERATION",
        });
        try {
          await recoverWriteNotification(
            project,
            "original",
            "https://relay.test",
            observed.effects,
          );
          expect(observed.events).toEqual(["started", "refresh"]);
          expect(getPendingWrite(project)).toEqual({ operationKey: "next", recovering: false });
        } finally {
          await recoverPendingWrite(project, "next");
        }
      },
    );
  });

  test("поздняя ошибка после ухода не меняет уведомление нового экземпляра проекта", async () => {
    const project = "recovery-ui-late-error";
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let active = true;
    let cleanup = false;
    const observed = feedback(
      async () => undefined,
      () => active,
    );

    await withAdapterHttp(
      async (request) => {
        if (request.method === "POST") {
          throw new TypeError("Ответ потерян");
        }
        if (cleanup) {
          return receiptResponse(request);
        }
        started.resolve();
        await release.promise;
        return Response.json(
          { ok: false, error: { code: "UNAVAILABLE", message: "Сервер недоступен" } },
          { status: 503 },
        );
      },
      async () => {
        await expect(writeCommands(project, [command], "original")).rejects.toMatchObject({
          code: "UNRESOLVED_OPERATION",
        });
        try {
          const pending = recoverWriteNotification(
            project,
            "original",
            "https://relay.test",
            observed.effects,
          );
          await started.promise;
          active = false;
          release.resolve();
          await pending;

          expect(observed.events).toEqual(["started"]);
          expect(getPendingWrite(project)).toEqual({ operationKey: "original", recovering: false });
        } finally {
          release.resolve();
          cleanup = true;
          await recoverPendingWrite(project, "original");
        }
      },
    );
  });

  test.each([
    { name: "ошибка receipt", missing: false, expected: "uncertain:" },
    {
      name: "достоверный CAS после NOT_FOUND",
      missing: true,
      expected: "rejected:Ревизия изменилась",
    },
  ])("$name не выдаётся за подтверждение записи", async ({ missing, expected }) => {
    const project = `recovery-ui-failure-${missing}`;
    let posts = 0;
    let cleanup = false;
    const observed = feedback(async () => undefined);
    await withAdapterHttp(
      (request) => {
        if (cleanup) {
          return receiptResponse(request);
        }
        if (request.method === "POST") {
          if (++posts === 1) {
            throw new TypeError("Ответ потерян");
          }
          return Response.json(
            { ok: false, error: { code: "REVISION_CONFLICT", message: "Ревизия изменилась" } },
            { status: 409 },
          );
        }
        return Response.json(
          {
            ok: false,
            error: { code: missing ? "NOT_FOUND" : "UNAVAILABLE", message: "Нет квитанции" },
          },
          { status: missing ? 404 : 503 },
        );
      },
      async () => {
        await expect(writeCommands(project, [command], "original")).rejects.toMatchObject({
          code: "UNRESOLVED_OPERATION",
        });
        try {
          await recoverWriteNotification(
            project,
            "original",
            "https://relay.test",
            observed.effects,
          );
          expect(observed.events).toHaveLength(2);
          expect(observed.events[0]).toBe("started");
          expect(observed.events[1]).toStartWith(expected);
          expect(getPendingWrite(project)?.operationKey ?? null).toBe(missing ? null : "original");
        } finally {
          cleanup = true;
          await recoverPendingWrite(project, "original");
        }
      },
    );
  });
});
