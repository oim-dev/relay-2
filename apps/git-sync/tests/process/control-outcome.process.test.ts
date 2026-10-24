import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { withProcessFixture, eventually } from "./process-fixture";
import { ownControl, responsive } from "../../src/local/control";
import { ControlOperations, operationId } from "../../src/local/operations";
import { getOperation, submitOperation, waitOperation } from "../../src/local/operation-client";
import { stateDirectory } from "../../src/local/state";
import { readLocalJson, writeLocalJson } from "../../src/local/files";
import { requestObject } from "../../src/app/protocol";

describe("Коррелированный исход принятой операции", () => {
  test("deadline ожидания не означает not-ready: live и terminal исход читаются по тому же ID", async () => {
    await withProcessFixture(async (fixture) => {
      const databasePath = join(fixture.root, "operation.sqlite");
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
            throw new Error("not initialized");
          }
          if (request.action === "operation.get") {
            return operations.get(operationId(request.input.requestId));
          }
          return operations.submit(request.requestId, "now", "now", async (started) => {
            executions++;
            started();
            await gate.promise;
            return { marker: "delivered-once" };
          });
        },
      );
      operations = new ControlOperations(directory, owner.endpoint.instance);
      const id = crypto.randomUUID();
      try {
        await submitOperation(owner.endpoint, id, "now");
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
        await eventually(
          async () => (await getOperation(directory, id, owner.endpoint)).state === "completed",
        );
        expect(await waitOperation(directory, id, 100, owner.endpoint)).toEqual({
          requestId: id,
          marker: "delivered-once",
        });
        await submitOperation(owner.endpoint, id, "now");
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
        throw new Error("expected retained outcomes");
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
