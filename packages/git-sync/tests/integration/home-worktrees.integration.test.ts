import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { KnowledgeService, ProjectDatabase } from "@relay/core";
import { initializeProject, openProject } from "@relay/project-runtime";
import { executeGitSyncRequest } from "../../src/index";
import * as control from "../../src/local/control";
import { decodeSnapshot } from "../../src/snapshot/codec";
import { git, requireGit } from "../../src/transport/git";
import { DataRepository } from "../../src/transport/repository";
import { withGitRepository } from "./helpers/git-repository-fixture";
import { createLocalProject } from "./helpers/local-project";

describe("Общее домашнее хранилище worktree", () => {
  test("обращения из разных worktree разделяют реплику и транспорт после удаления первого checkout", async () => {
    await withGitRepository(async (remoteRepository, root, env) => {
      const main = join(root, "project");
      const home = join(root, "relay-home");
      const userHome = join(root, "user-home");
      mkdirSync(main);
      mkdirSync(userHome);
      const gitEnvironment = {
        ...process.env,
        ...env,
        HOME: userHome,
        USERPROFILE: userHome,
        RELAY_HOME: home,
      };
      requireGit(
        await git(main, ["init", "--initial-branch=main", "."], { env: gitEnvironment }),
        "project-init",
      );
      requireGit(
        await git(main, ["remote", "add", "origin", remoteRepository.options.remote], {
          env: gitEnvironment,
        }),
        "project-origin",
      );
      const location = initializeProject({ cwd: main, home, name: "Общая память worktree" });
      const project = {
        root: main,
        location,
        database: ProjectDatabase.open(location.databasePath),
      };
      const cancellation = new AbortController();
      try {
        requireGit(
          await git(project.root, ["add", "relay.config.json"], { env: gitEnvironment }),
          "config-add",
        );
        requireGit(
          await git(project.root, ["commit", "-m", "Привязка Relay"], { env: gitEnvironment }),
          "config-commit",
        );
        const checkout = join(root, "feature");
        requireGit(
          await git(project.root, ["worktree", "add", "-b", "feature", checkout], {
            env: gitEnvironment,
          }),
          "feature-worktree",
        );
        const selected = openProject({ cwd: checkout, home });
        const replicaId = project.database.getReplicationStatus().replicaId;
        const initialOutbox = project.database.getReplicationOutbox();
        let documentId: string;
        try {
          expect(selected.location.databasePath).toBe(project.location.databasePath);
          expect(selected.database.getReplicationStatus().replicaId).toBe(replicaId);
          const document = await new KnowledgeService(selected.database).create(
            "document",
            { name: "Из worktree", body: "Одна общая память" },
            "author",
          );
          documentId = document.id;
          const outbox = selected.database.getReplicationOutbox();
          expect(outbox).toHaveLength(initialOutbox.length + 1);
          expect(project.database.getReplicationOutbox()).toEqual(outbox);
        } finally {
          selected.database.close();
        }
        const environment = {
          env: gitEnvironment,
          signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(20_000)]),
        };
        const dataDirectory = join(dirname(project.location.databasePath), "data");
        // Первый транспорт создаёт именно linked caller, а не helper подготовки основного checkout.
        expect(existsSync(dataDirectory)).toBe(false);
        await executeGitSyncRequest(
          { version: 1, action: "now", options: { cwd: checkout, home } },
          environment,
        );
        const connectionPath = join(
          dirname(project.location.databasePath),
          "state",
          "connection.json",
        );
        const connection = readFileSync(connectionPath);
        expect(JSON.parse(connection.toString())).toMatchObject({
          worktree: checkout,
          gitCommonDirectory: realpathSync(join(project.root, ".git")),
        });
        const concurrent = await new KnowledgeService(project.database).create(
          "document",
          { name: "Перед гонкой", body: "Очередь общая для обоих now" },
          "author",
        );
        const endpointPath = join(dirname(project.location.databasePath), "state", "worker.json");
        const enteredFetch = Promise.withResolvers<void>();
        const releaseFetch = Promise.withResolvers<void>();
        const observedOwner = Promise.withResolvers<void>();
        const nativeFetch = DataRepository.prototype.fetch;
        const nativeResponsive = control.responsive;
        let fetches = 0;
        /**
         * Удерживает только первый настоящий fetch до наблюдения конкурентом живого общего owner.
         * Git и Storage mutex не подменяются; finally теста освобождает барьер и ждёт оба обращения.
         */
        async function fetchAfterBarrier(
          this: DataRepository,
        ): ReturnType<DataRepository["fetch"]> {
          if (this.options.directory === dataDirectory && ++fetches === 1) {
            enteredFetch.resolve();
            await releaseFetch.promise;
          }
          return nativeFetch.call(this);
        }
        /**
         * Наблюдает настоящий challenge-response второго now, не меняя решения о занятости owner.
         */
        async function observeResponsive(
          ...args: Parameters<typeof control.responsive>
        ): ReturnType<typeof control.responsive> {
          const responsive = await nativeResponsive(...args);
          if (responsive && args[0].identity === project.location.databasePath) {
            observedOwner.resolve();
          }
          return responsive;
        }
        const fetch = spyOn(DataRepository.prototype, "fetch").mockImplementation(
          fetchAfterBarrier,
        );
        const responsive = spyOn(control, "responsive").mockImplementation(observeResponsive);
        const first = executeGitSyncRequest(
          { version: 1, action: "now", options: { cwd: project.root, home } },
          environment,
        );
        const completions: Promise<unknown>[] = [first];
        let results: unknown[];
        try {
          await Promise.race([
            enteredFetch.promise,
            first.then(() => {
              throw new Error("Первый now завершился до fetch-барьера");
            }),
          ]);
          expect(() => {
            const lock = control.acquireControlLock(endpointPath);
            lock.release();
          }).toThrow(expect.objectContaining({ code: "GIT_SYNC_WORKER_BUSY" }));
          const second = executeGitSyncRequest(
            { version: 1, action: "now", options: { cwd: checkout, home } },
            environment,
          );
          completions.push(second);
          await Promise.race([
            observedOwner.promise,
            second.then(() => {
              throw new Error("Второй now обошёл живого общего owner");
            }),
          ]);

          expect(fetches).toBe(1);
          expect(project.database.getReplicationOutbox()).toHaveLength(1);
          releaseFetch.resolve();
          results = await Promise.all(completions);
        } finally {
          releaseFetch.resolve();
          await Promise.allSettled(completions);
          responsive.mockRestore();
          fetch.mockRestore();
        }
        requireGit(
          await git(project.root, ["worktree", "remove", checkout], { env: gitEnvironment }),
          "remove-feature",
        );
        const afterRemovalDocument = await new KnowledgeService(project.database).create(
          "document",
          { name: "После удаления", body: "Новая доставка без первого caller" },
          "author",
        );
        const afterRemoval = await executeGitSyncRequest(
          { version: 1, action: "now", options: { cwd: project.root, home } },
          environment,
        );

        expect(results).toHaveLength(2);
        for (const result of [...results, afterRemoval]) {
          expect(result).toMatchObject({ pending: { changesets: 0 }, branch: "relay-data" });
        }
        expect(project.database.get(documentId)?.data.body).toBe("Одна общая память");
        expect(project.database.getReplicationStatus()).toMatchObject({ replicaId, pending: 0 });
        expect(project.database.getReplicationOutbox()).toEqual([]);
        expect(readFileSync(connectionPath)).toEqual(connection);
        const remoteReader = new DataRepository({
          ...remoteRepository.options,
          branch: "relay-data",
        });
        const remoteHead = await remoteReader.fetch();
        if (remoteHead === null) {
          throw new Error("После now отсутствует опубликованная ветка");
        }
        const published = decodeSnapshot(await remoteReader.files(remoteHead));
        expect(
          published.entities.find((entry) => entry.record.id === documentId)?.record.data.body,
        ).toBe("Одна общая память");
        expect(
          published.entities.find((entry) => entry.record.id === concurrent.id)?.record.data.body,
        ).toBe("Очередь общая для обоих now");
        expect(
          published.entities.find((entry) => entry.record.id === afterRemovalDocument.id)?.record
            .data.body,
        ).toBe("Новая доставка без первого caller");
        expect(
          requireGit(
            await git(project.root, ["worktree", "list", "--porcelain"], { env: gitEnvironment }),
            "remaining-worktrees",
          )
            .split("\n")
            .filter((line) => line.startsWith("worktree "))
            .map((line) => line.slice("worktree ".length))
            .sort(),
        ).toEqual([project.root, dataDirectory].sort());
        expect(existsSync(endpointPath)).toBe(false);
        expect(existsSync(join(project.root, ".relay"))).toBe(false);
        expect(existsSync(checkout)).toBe(false);
      } finally {
        cancellation.abort();
        project.database.close();
      }
    });
  }, 30_000);

  test("независимый клон с тем же ID не присваивает транспорт существующей реплики", async () => {
    await withGitRepository(async (remoteRepository, root, env) => {
      const project = await createLocalProject(
        join(root, "project"),
        remoteRepository.options.remote,
        env,
      );
      try {
        const home = join(project.root, "home");
        requireGit(await git(project.root, ["add", "relay.config.json"], { env }), "config-add");
        requireGit(
          await git(project.root, ["commit", "-m", "Привязка Relay"], { env }),
          "config-commit",
        );
        const environment = {
          env: {
            ...process.env,
            ...env,
            HOME: join(project.root, "os-home"),
            USERPROFILE: join(project.root, "os-home"),
            RELAY_HOME: home,
          },
        };
        await executeGitSyncRequest(
          { version: 1, action: "now", options: { cwd: project.root, home } },
          environment,
        );
        const connectionPath = join(
          dirname(project.location.databasePath),
          "state",
          "connection.json",
        );
        const before = readFileSync(connectionPath);
        const document = await new KnowledgeService(project.database).create(
          "document",
          { name: "Не передавать клону", body: "Pending должен сохраниться" },
          "author",
        );
        const outbox = project.database.getReplicationOutbox();
        const state = project.database.getReplicationState();
        const head = await project.repository.acceptedCommit();
        const clone = join(root, "independent-clone");
        requireGit(
          await git(root, ["clone", "--no-hardlinks", project.root, clone], { env }),
          "independent-clone",
        );

        await expect(
          executeGitSyncRequest(
            { version: 1, action: "now", options: { cwd: clone, home } },
            environment,
          ),
        ).rejects.toMatchObject({ code: "GIT_REPOSITORY_MISMATCH" });

        expect(readFileSync(connectionPath)).toEqual(before);
        expect(outbox).toHaveLength(1);
        expect(project.database.getReplicationOutbox()).toEqual(outbox);
        expect(project.database.getReplicationState()).toEqual(state);
        expect(project.database.get(document.id)?.data.body).toBe("Pending должен сохраниться");
        expect(await project.repository.acceptedCommit()).toBe(head);
        expect(await project.repository.fetch()).toBe(head);
        expect(existsSync(join(clone, ".relay"))).toBe(false);
      } finally {
        project.database.close();
      }
    });
  }, 30_000);
});
