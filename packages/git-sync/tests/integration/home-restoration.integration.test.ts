import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { KnowledgeService } from "@relay/core";
import { openProject } from "@relay/project-runtime";
import { executeGitSyncRequest } from "../../src/index";
import * as preparation from "../../src/app/restore-preparation";
import * as control from "../../src/local/control";
import type { ControlOwner } from "../../src/local/control.types";
import { git, requireGit } from "../../src/transport/git";
import { DataRepository } from "../../src/transport/repository";
import { withGitRepository } from "./helpers/git-repository-fixture";
import { createLocalProject } from "./helpers/local-project";

const restorationTargets = [
  { name: "неизвестный до fetch ID", existingConfig: false },
  { name: "ID существующего config", existingConfig: true },
] as const;

describe("Восстановление в домашнюю область независимой реплики", () => {
  test.each(restorationTargets)(
    "$name выбирает SQLite и транспорт в отдельном home без повторного echo",
    async ({ existingConfig }) => {
      await withGitRepository(async (remote, root, env) => {
        const source = await createLocalProject(join(root, "source"), remote.options.remote, env);
        try {
          const document = await new KnowledgeService(source.database).create(
            "document",
            { name: "Переносимый документ", body: "  Точный текст\r\n🧅\n" },
            "author",
          );
          await source.engine.run();
          const head = await source.repository.acceptedCommit();
          if (head === null) {
            throw new Error("Исходная реплика не опубликовала snapshot");
          }
          const sourceReplicaId = source.replication.status().replicaId;
          const cwd = join(root, "target");
          const home = join(root, "target-relay-home");
          const userHome = join(root, "target-user-home");
          mkdirSync(cwd);
          mkdirSync(userHome);
          const configPath = join(cwd, "relay.config.json");
          const config = `{\n  "version": 1, "projectId": ${JSON.stringify(source.location.projectId)}\n}\n`;
          if (existingConfig) {
            writeFileSync(configPath, config);
          }
          const options = { cwd, home };
          const environment = {
            env: {
              ...process.env,
              ...env,
              HOME: userHome,
              USERPROFILE: userHome,
              RELAY_HOME: home,
            },
          };
          const databasePath = join(home, "projects", source.location.projectId, "project.sqlite");

          const restored = await executeGitSyncRequest(
            { version: 1, action: "restore", options, input: { remote: remote.options.remote } },
            environment,
          );

          expect(restored).toMatchObject({
            restored: true,
            projectId: source.location.projectId,
            databasePath,
            configPath,
            commit: head,
          });
          const actualConfig = readFileSync(configPath, "utf8");
          expect(JSON.parse(actualConfig)).toEqual({
            version: 1,
            projectId: source.location.projectId,
          });
          if (existingConfig) {
            expect(actualConfig).toBe(config);
          }
          const target = openProject(options);
          try {
            expect(target.location.databasePath).toBe(databasePath);
            expect(target.database.get(document.id)?.data.body).toBe("  Точный текст\r\n🧅\n");
            const replicaId = target.database.getReplicationStatus().replicaId;
            expect(replicaId).not.toBe(sourceReplicaId);
            expect(target.database.getReplicationOutbox()).toEqual([]);
            expect(
              requireGit(
                await git(cwd, ["rev-parse", `refs/relay/${replicaId}/accepted`], {
                  env: environment.env,
                }),
                "restored-accepted",
              ),
            ).toBe(head);

            const now = await executeGitSyncRequest(
              { version: 1, action: "now", options },
              environment,
            );

            expect(now).toMatchObject({ pending: { changesets: 0 }, branch: "relay-data" });
            expect(target.database.getReplicationStatus()).toMatchObject({ replicaId, pending: 0 });
            expect(await source.repository.fetch()).toBe(head);
          } finally {
            target.database.close();
          }
          const directory = dirname(databasePath);
          expect(existsSync(join(directory, "data", "manifest.json"))).toBe(true);
          expect(existsSync(join(directory, "state", "worker.json"))).toBe(false);
          expect(existsSync(join(cwd, ".relay"))).toBe(false);
          expect(existsSync(join(cwd, ".gitignore"))).toBe(false);
        } finally {
          source.database.close();
        }
      });
    },
    30_000,
  );

  test("отмена после preflight неизвестного ID убирает private staging и оба owner до возврата, повтор восстанавливается", async () => {
    await withGitRepository(async (remote, root, env) => {
      const source = await createLocalProject(join(root, "source"), remote.options.remote, env);
      try {
        const document = await new KnowledgeService(source.database).create(
          "document",
          { name: "После отмены", body: "Сохранный источник для повтора" },
          "author",
        );
        await source.engine.run();
        const sourceOutbox = source.database.getReplicationOutbox();
        const sourceState = source.database.getReplicationState();
        const cwd = join(root, "target");
        const home = join(root, "target-relay-home");
        const userHome = join(root, "target-user-home");
        mkdirSync(cwd);
        mkdirSync(userHome);
        const options = { cwd, home };
        const environment = {
          env: { ...process.env, ...env, HOME: userHome, USERPROFILE: userHome, RELAY_HOME: home },
        };
        const directory = join(home, "projects", source.location.projectId);
        const controller = new AbortController();
        const owners = new Map<string, ControlOwner>();
        const stagingDirectories: string[] = [];
        const actualOwn = control.ownControl;
        const actualPrepare = preparation.prepareRestoration;
        const actualCounts = DataRepository.prototype.counts;
        /**
         * Сохраняет реальные listener/endpoint для проверки полного освобождения обоих transport owner.
         */
        async function observeOwner(
          ...args: Parameters<typeof control.ownControl>
        ): ReturnType<typeof control.ownControl> {
          const owner = await actualOwn(...args);
          owners.set(args[0], owner);
          return owner;
        }
        /**
         * Наблюдает переданный private staging, не подменяя fetch, Core bootstrap или SQLite.
         */
        function observePreparation(
          input: Parameters<typeof preparation.prepareRestoration>[0],
        ): ReturnType<typeof preparation.prepareRestoration> {
          stagingDirectories.push(input.directory);
          return actualPrepare(input);
        }
        /**
         * Отменяет на последнем успешном Git-чтении target до публикации config и SQLite Runtime.
         */
        async function cancelAfterPreflight(
          this: DataRepository,
        ): ReturnType<DataRepository["counts"]> {
          const counts = await actualCounts.call(this);
          if (this.options.directory === join(directory, "data")) {
            controller.abort("SIGTERM");
          }
          return counts;
        }
        const own = spyOn(control, "ownControl").mockImplementation(observeOwner);
        const prepare = spyOn(preparation, "prepareRestoration").mockImplementation(
          observePreparation,
        );
        const counts = spyOn(DataRepository.prototype, "counts").mockImplementation(
          cancelAfterPreflight,
        );
        try {
          const failure: unknown = await executeGitSyncRequest(
            { version: 1, action: "restore", options, input: { remote: remote.options.remote } },
            { ...environment, signal: controller.signal },
          ).catch((error: unknown) => error);

          expect(controller.signal.aborted).toBe(true);
          expect(failure).toMatchObject({ code: "GIT_SYNC_CANCELLED", exitCode: 143 });
          expect(existsSync(join(directory, "project.sqlite"))).toBe(false);
          expect(existsSync(join(cwd, "relay.config.json"))).toBe(false);
          expect(existsSync(join(directory, "state", "connection.json"))).toBe(false);
          expect(existsSync(join(directory, "state", "progress.json"))).toBe(false);
          expect(stagingDirectories).toHaveLength(1);
          for (const staging of stagingDirectories) {
            expect(staging.startsWith(`${home}${sep}`)).toBe(true);
            expect(existsSync(staging)).toBe(false);
          }
          expect(owners.size).toBe(2);
          expect(owners.has(join(directory, "state", "worker.json"))).toBe(true);
          for (const [path, owner] of owners) {
            expect(path.startsWith(`${home}${sep}`)).toBe(true);
            expect(existsSync(path)).toBe(false);
            expect(await control.responsive(owner.endpoint)).toBe(false);
            const lock = control.acquireControlLock(path);
            lock.release();
          }
          expect(source.database.getReplicationOutbox()).toEqual(sourceOutbox);
          expect(source.database.getReplicationState()).toEqual(sourceState);
        } finally {
          controller.abort();
          counts.mockRestore();
          prepare.mockRestore();
          own.mockRestore();
          for (const owner of owners.values()) {
            await owner.close();
          }
        }

        const retried = await executeGitSyncRequest(
          { version: 1, action: "restore", options, input: { remote: remote.options.remote } },
          environment,
        );

        expect(retried).toMatchObject({
          restored: true,
          projectId: source.location.projectId,
          databasePath: join(directory, "project.sqlite"),
        });
        const reopened = openProject(options);
        try {
          expect(reopened.database.get(document.id)?.data.body).toBe(
            "Сохранный источник для повтора",
          );
        } finally {
          reopened.database.close();
        }
      } finally {
        source.database.close();
      }
    });
  }, 30_000);
});
