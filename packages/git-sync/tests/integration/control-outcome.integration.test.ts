import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { withRuntimeDirectory } from "./helpers/source-runtime-fixture";
import { ownControl, responsive } from "../../src/local/control";
import { ControlOperations, operationId } from "../../src/local/operations";
import { getOperation, waitOperation } from "../../src/local/operation-client";
import { stateDirectory } from "../../src/local/state";
import { readLocalJson, writeLocalJson } from "../../src/local/files";
import { requestObject } from "../../src/app/protocol";

describe("Коррелированный исход принятой операции", () => {
  test("deadline ожидания не означает not-ready: live и terminal исход читаются по тому же ID", async () => {
    await withRuntimeDirectory(async (root) => {
      const databasePath = join(root, "operation.sqlite");
      const directory = stateDirectory(databasePath);
      const gate = Promise.withResolvers<void>();
      let operations: ControlOperations | undefined;
      let executions = 0;
      const owner = await ownControl(
        join(directory, "worker.json"),
        "request",
        databasePath,
        async (request) => {
          if (!operations) {
            throw new Error("Реестр операций ещё не инициализирован");
          }
          if (request.action === "operation.get") {
            return operations.get(operationId(request.input.requestId));
          }
          throw new Error("Одноразовый owner принимает здесь только чтение исхода");
        },
      );
      operations = new ControlOperations(directory, owner.endpoint.instance);
      const id = crypto.randomUUID();
      /**
       * Барьер отделяет принятый running от terminal outcome без Git и задержек подготовки.
       */
      const execute = async (started: () => void): Promise<unknown> => {
        executions++;
        started();
        await gate.promise;
        return { marker: "delivered-once" };
      };
      try {
        operations.submit(id, "now", "now", execute);
        await expect(waitOperation(directory, id, 40, owner.endpoint)).rejects.toMatchObject({
          code: "GIT_SYNC_WAIT_TIMEOUT",
          details: { requestId: id, state: "running" },
        });
        expect(await responsive(owner.endpoint)).toBe(true);
        expect(await getOperation(directory, id, owner.endpoint)).toMatchObject({
          requestId: id,
          state: "running",
          instance: owner.endpoint.instance,
        });

        gate.resolve();
        await operations.settled();
        expect(await getOperation(directory, id, owner.endpoint)).toMatchObject({
          state: "completed",
        });
        expect(await waitOperation(directory, id, 100, owner.endpoint)).toEqual({
          requestId: id,
          marker: "delivered-once",
        });
        operations.submit(id, "now", "now", execute);
        expect(executions).toBe(1);
      } finally {
        gate.resolve();
        await operations.settled();
        await owner.close();
      }
      expect(await getOperation(directory, id)).toMatchObject({
        requestId: id,
        state: "completed",
      });
      const saved = requestObject(readLocalJson(join(directory, "control-outcomes.json")));
      if (!Array.isArray(saved.items)) {
        throw new Error("Ожидался сохранённый журнал исходов");
      }
      writeLocalJson(join(directory, "control-outcomes.json"), {
        version: 1,
        items: saved.items.map((item) => ({ ...requestObject(item), expires: 0 })),
      });
      expect(await getOperation(directory, id)).toMatchObject({ requestId: id, state: "unknown" });
      await expect(waitOperation(directory, id, 100)).rejects.toMatchObject({
        code: "GIT_SYNC_OUTCOME_UNKNOWN",
      });
      expect(executions).toBe(1);
    });
  }, 15_000);
});
