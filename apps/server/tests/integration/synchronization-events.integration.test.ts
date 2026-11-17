import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { GitSyncRequest, PortableProjectSnapshot } from "@relay/contracts";
import { KnowledgeService, ReplicationService } from "@relay/core";
import { openProject } from "@relay/project-runtime";
import { ProjectDatabase } from "@relay/storage";
import { events } from "./events-fixture";
import { withServer } from "./fixture";
import { prepareDueSynchronization } from "./synchronization-fixture";
import { deadline } from "../process/process-fixture";

describe("SSE после фонового импорта независимой реплики", () => {
  test("локальный HTTP-ответ приходит раньше импорта, changed приводит к чтению удалённой правки", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const calls: GitSyncRequest[] = [];
    const warnings: string[] = [];
    let published: PortableProjectSnapshot | undefined;
    await withServer(
      async ({ client, database, directory, location }) => {
        const initial = await database((db) =>
          new KnowledgeService(db).create(
            "document",
            { name: "Общий документ", body: "До импорта" },
            "local",
          ),
        );
        const base = await database((db) => {
          const replication = new ReplicationService(db);
          const snapshot = replication.prepare(null).snapshot;
          replication.accept(snapshot);
          return snapshot;
        });
        const remote = ProjectDatabase.createReplica(
          join(directory, "remote.sqlite"),
          location.projectId,
        );
        try {
          const replication = new ReplicationService(remote);
          replication.bootstrap(base);
          const knowledge = new KnowledgeService(remote);
          const document = knowledge.get("document", initial.id);
          await knowledge.update(
            "document",
            document.id,
            { body: "Из независимой реплики" },
            { actor: "remote", ifRevision: document.revision },
          );
          published = replication.prepare(base).snapshot;
        } finally {
          remote.close();
        }
        prepareDueSynchronization(location);
        const response = await fetch(client.eventsUrl(location.projectId), {
          signal: AbortSignal.timeout(3000),
        });
        const reader = response.body?.getReader();
        if (reader === undefined) {
          throw new Error("Нет SSE body");
        }
        const next = events(reader);
        try {
          const connected = await next();

          const local = await deadline(client.entity(location.projectId, initial.id), 2000);
          await deadline(entered.promise, 2000);

          expect(response.status).toBe(200);
          expect(connected).toMatchObject({ type: "connected", projectId: location.projectId });
          expect(local.data).toMatchObject({
            id: initial.id,
            revision: initial.revision,
            data: { body: "До импорта" },
          });
          release.resolve();
          let changed = await next();
          while (changed.type === "heartbeat") {
            changed = await next();
          }

          expect(changed).toMatchObject({ type: "changed", projectId: location.projectId });
          expect(changed.generation).toBeGreaterThan(Number(connected.generation));
          expect(changed.generation).toBe(await database((db) => db.getGeneration()));
          const fresh = await client.entity(location.projectId, initial.id);
          expect(fresh.data).toMatchObject({
            id: initial.id,
            revision: initial.revision + 1,
            data: { body: "Из независимой реплики" },
            updatedBy: "remote",
          });
          expect(calls.map((request) => request.action)).toEqual(["auto"]);
          expect(warnings).toEqual([]);
        } finally {
          release.resolve();
          await reader.cancel();
        }
      },
      {
        /**
         * Импорт не должен терять ошибку за успешным первым HTTP-чтением.
         */
        synchronizationWarning: (error): void => {
          warnings.push(error.code);
        },
        gitSync: {
          /**
           * Подменяет только получение remote: реальный Core импортирует snapshot во второе
           * соединение, а штатный watcher обнаруживает commit без ручного SSE-уведомления.
           */
          request: async (request): Promise<null> => {
            calls.push(request);
            entered.resolve();
            await release.promise;
            if (published === undefined) {
              throw new Error("Удалённая публикация не подготовлена");
            }
            const { database } = openProject(request.options);
            try {
              new ReplicationService(database).accept(published);
              const at = Date.now();
              database.completeSynchronizationAttempt({
                at,
                nextAttemptAt: at + 60_000,
                failed: false,
              });
              return null;
            } finally {
              database.close();
            }
          },
        },
      },
      "background-sync-tests/fixtures",
    );
  });
});
