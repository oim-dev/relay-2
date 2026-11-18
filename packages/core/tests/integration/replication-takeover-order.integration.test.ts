import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { ProjectDatabase } from "@relay/storage";
import { HistoryService } from "../../src/history/history";
import { ReplicationService } from "../../src/replication/replication";

const runOrders = [
  { name: "новый ID меньше прежнего", step: -1 },
  { name: "новый ID больше прежнего", step: 1 },
] as const;

describe("Порядок применения участий при репликации takeover", () => {
  test.each(runOrders)(
    "$name: приёмка сохраняет историю и единственное активное участие без echo",
    async ({ step }) => {
      const artifacts = resolve(
        import.meta.dir,
        "../../../../.artifacts",
        new Date().toISOString().slice(0, 10),
        "database-redesign",
      );
      mkdirSync(artifacts, { recursive: true });
      const directory = mkdtempSync(join(artifacts, "takeover-order-"));
      let first: ProjectDatabase | undefined;
      let second: ProjectDatabase | undefined;
      let allocated = 0x1000;
      // Подменён только allocator: оба порядка scoped UUID проходят реальные Core, SQLite и acceptance.
      const uuid = spyOn(crypto, "randomUUID").mockImplementation(() => {
        allocated += step;
        return `${allocated.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
      });
      try {
        first = ProjectDatabase.create(join(directory, "first.sqlite"), {
          id: "takeover-project",
          name: "История передачи",
          slug: "takeover",
        });
        const initial = await new HistoryService(first).start(
          { title: "Сохранить историю", description: "Исходный текст\r\n" },
          "original-owner",
        );
        const initialRun = initial.data.runs[0];
        if (initialRun === undefined || initial.data.currentRunId === null) {
          throw new Error("Начальная сессия должна содержать активное участие");
        }
        const receiver = new ReplicationService(first);
        const baseline = receiver.prepare(null);
        expect(baseline.conflicts).toEqual([]);
        receiver.accept(baseline.snapshot);
        second = ProjectDatabase.createReplica(join(directory, "second.sqlite"), first.projectId);
        const publisher = new ReplicationService(second);
        publisher.bootstrap(baseline.snapshot);
        const owner = new HistoryService(second);
        const before = owner.get(initial.id);
        const reason = "Передача следующему автору\r\nс точным основанием";
        const taken = await owner.transition(
          before.id,
          "takeover",
          { reason },
          { actor: "next-owner", ifRevision: before.revision },
        );
        if (taken.data.currentRunId === null) {
          throw new Error("Takeover должен выделить новое активное участие");
        }
        expect(taken.data.currentRunId < initialRun.id).toBe(step < 0);
        const prepared = publisher.prepare(baseline.snapshot);
        expect(prepared.conflicts).toEqual([]);
        publisher.accept(prepared.snapshot);

        receiver.accept(prepared.snapshot);

        const received = new HistoryService(first).get(initial.id);
        expect(received).toEqual(taken);
        expect(received.createdBy).toBe("original-owner");
        expect(received.data.description).toBe("Исходный текст\r\n");
        expect(received.data.runs).toHaveLength(2);
        expect(received.data.runs[0]).toMatchObject({
          ...initialRun,
          state: "transferred",
          endedAt: taken.data.runs[0]?.endedAt,
          endReason: reason,
        });
        expect(received.data.runs[1]).toMatchObject({
          id: taken.data.currentRunId,
          actor: "next-owner",
          state: "active",
          predecessorRunId: initialRun.id,
          reason,
          endedAt: null,
          endReason: null,
        });
        expect(received.data.runs.filter((run) => run.state === "active")).toHaveLength(1);
        expect(first.getComponents([initial.id])).toEqual(second.getComponents([initial.id]));
        expect(first.getReplicationOutbox()).toEqual([]);
        expect(second.getReplicationOutbox()).toEqual([]);
      } finally {
        uuid.mockRestore();
        try {
          second?.close();
        } finally {
          try {
            first?.close();
          } finally {
            rmSync(directory, { recursive: true, force: true });
          }
        }
      }
    },
  );
});
