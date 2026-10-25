import { describe, expect, test } from "bun:test";
import { KnowledgeService } from "@relay/core";
import { withServer, apiError } from "./fixture";

describe("Nest команды, точный ввод и receipts", () => {
  test.each([".", "..", "ключ /?&=# % пробел"])(
    "receipt сохраняет буквальный query key %s и replay не повторяет запись",
    async (operationKey) => {
      await withServer(async ({ client, location }) => {
        const command = {
          op: "document.create" as const,
          input: { name: "Исходный документ", body: "Текст\ud800x\udfff\u0000\n  " },
          actor: "Автор",
          operationKey,
        };

        const original = await client.command(location.projectId, command);
        const receipt = await client.receipt(location.projectId, operationKey);
        const replay = await client.command(location.projectId, command);
        const page = await client.entities(location.projectId, { kind: "document" });

        expect(original.data.replayed).toBe(false);
        expect(receipt.data).toEqual({ ...original.data, replayed: true });
        expect(replay.data).toEqual(receipt.data);
        expect(page.data.total).toBe(1);
        expect(page.data.items[0]).toMatchObject({
          kind: "document",
          data: command.input,
          createdBy: "Автор",
        });
        await apiError(
          () =>
            client.command(location.projectId, {
              ...command,
              input: { ...command.input, body: "Другой запрос" },
            }),
          "CONFLICT",
          409,
        );
        expect(
          (await client.entities(location.projectId, { kind: "document" })).data.items,
        ).toEqual(page.data.items);
      });
    },
  );

  test("receipt после внешней правки возвращает исходную карточку, не текущую версию", async () => {
    await withServer(async ({ client, location, database }) => {
      const request = {
        op: "document.create" as const,
        input: { name: "Первоначальный", body: "Исходный" },
        actor: "Web",
        operationKey: "original",
      };
      const created = await client.command(location.projectId, request);
      const document = created.data.entities.find((entity) => entity.kind === "document");
      if (document === undefined) {
        throw new Error("Не создан документ");
      }
      const updated = await database((db) =>
        new KnowledgeService(db).update(
          "document",
          document.id,
          { body: "Поздняя запись CLI" },
          { actor: "CLI", ifRevision: document.revision },
        ),
      );

      expect((await client.receipt(location.projectId, "original")).data).toEqual({
        ...created.data,
        replayed: true,
      });
      expect((await client.command(location.projectId, request)).data).toEqual({
        ...created.data,
        replayed: true,
      });
      expect((await client.entity(location.projectId, document.id)).data).toEqual(updated);
    });
  });

  test("два HTTP writer с одной исходной ревизией сохраняют ровно одну правку", async () => {
    await withServer(async ({ client, location, database }) => {
      const document = await database((db) =>
        new KnowledgeService(db).create("document", { name: "Гонка", body: "Исходный" }, "CLI"),
      );
      const outcomes = await Promise.allSettled(
        ["Первая", "Вторая"].map((body) =>
          client.command(location.projectId, {
            op: "document.update",
            ref: document.id,
            ifRevision: document.revision,
            input: { body },
            actor: "Web",
            operationKey: body,
          }),
        ),
      );

      expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = outcomes.find((result) => result.status === "rejected");
      expect(rejected).toMatchObject({ reason: { status: 409 } });
      const failure: unknown = rejected?.status === "rejected" ? rejected.reason : null;
      if (failure === null || typeof failure !== "object" || !("code" in failure)) {
        throw new Error("Нет предметного конфликта writer");
      }
      expect(["REVISION_CONFLICT", "COMMAND_CONTEXT_CHANGED"]).toContain(String(failure.code));
      const current = (await client.entity(location.projectId, document.id)).data;
      expect(current.revision).toBe(document.revision + 1);
      if (current.kind !== "document") {
        throw new Error("Изменился вид записи");
      }
      expect(["Первая", "Вторая"]).toContain(current.data.body);
    });
  });

  test("исходный version token, numeric CAS и адресные guards не обновляются сервером", async () => {
    await withServer(async ({ client, location, database }) => {
      const initial = await database((db) =>
        new KnowledgeService(db).create("document", { name: "Документ", body: "Начало" }, "CLI"),
      );
      const snapshot = await client.entity(location.projectId, initial.id, { withVersions: true });
      const token = snapshot.meta?.versions?.[initial.id]?.aggregateVersion;
      expect(typeof token).toBe("string");
      if (token === undefined) {
        throw new Error("Не получен исходный token");
      }
      await client.command(location.projectId, {
        op: "document.update",
        ref: initial.id,
        expectedVersion: token,
        input: { body: "Актуально" },
        actor: "Web",
        operationKey: "update",
      });

      await apiError(
        () =>
          client.command(location.projectId, {
            op: "document.update",
            ref: initial.id,
            expectedVersion: token,
            input: { body: "Потерянное" },
            actor: "Web",
            operationKey: "stale-token",
          }),
        "VERSION_CONFLICT",
        409,
      );
      await apiError(
        () =>
          client.command(location.projectId, {
            op: "document.update",
            ref: initial.id,
            ifRevision: initial.revision,
            input: { body: "Потерянное" },
            actor: "Web",
            operationKey: "stale-cas",
          }),
        "REVISION_CONFLICT",
        409,
      );
      await apiError(
        () =>
          client.command(location.projectId, {
            op: "document.update",
            ref: initial.key,
            expectedAddresses: [{ ref: initial.key, expectedId: "неверный-id" }],
            input: { body: "Потерянное" },
            actor: "Web",
            operationKey: "stale-address",
          }),
        "ADDRESS_CHANGED",
        409,
      );
      expect((await client.entity(location.projectId, initial.id)).data).toMatchObject({
        data: { body: "Актуально" },
      });
    });
  });

  test("batch откатывает первый шаг при отказе второго, check не сохраняет receipt", async () => {
    await withServer(async ({ client, location }) => {
      const first = { op: "document.create" as const, input: { name: "Первый", body: "Текст" } };
      await apiError(
        () =>
          client.batch(location.projectId, {
            actor: "Web",
            operationKey: "rollback",
            commands: [
              first,
              {
                op: "document.update",
                ref: "несуществующий",
                ifRevision: 1,
                input: { body: "Отказ" },
              },
            ],
          }),
        "NOT_FOUND",
        404,
      );
      expect((await client.entities(location.projectId, { kind: "document" })).data.total).toBe(0);
      await client.batch(location.projectId, {
        actor: "Web",
        operationKey: "check",
        check: true,
        commands: [first],
      });
      await apiError(() => client.receipt(location.projectId, "check"), "NOT_FOUND", 404);
      expect((await client.entities(location.projectId, { kind: "document" })).data.total).toBe(0);
    });
  });

  test.each([
    { name: "пустой после пробелов", actor: " " },
    { name: "непустой с краевыми пробелами", actor: " Автор " },
  ])("actor $name отклоняется без нормализации, записи и receipt", async ({ actor }) => {
    await withServer(async ({ client, location, database }) => {
      const generation = await database((db) => db.getGeneration());

      await apiError(
        () =>
          client.command(location.projectId, {
            op: "document.create",
            input: { name: "Отказ", body: "Текст" },
            actor,
            operationKey: "actor",
          }),
        "INVALID_ARGUMENT",
        400,
      );

      expect((await client.entities(location.projectId, { kind: "document" })).data.total).toBe(0);
      expect(await database((db) => db.getGeneration())).toBe(generation);
      await apiError(() => client.receipt(location.projectId, "actor"), "NOT_FOUND", 404);
    });
  });

  test.each([
    { name: "отсутствующий ключ", suffix: "" },
    { name: "пустой ключ", suffix: "?operationKey=" },
    { name: "повторённый ключ", suffix: "?operationKey=x&operationKey=y" },
  ])("receipt: $name отклоняется как INVALID_ARGUMENT", async ({ suffix }) => {
    await withServer(async ({ server, client, location }) => {
      const response = await fetch(
        `${server.url}api/v2/projects/${location.projectId}/receipts${suffix}`,
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });
      expect((await client.entities(location.projectId, { kind: "document" })).data.total).toBe(0);
    });
  });
});
