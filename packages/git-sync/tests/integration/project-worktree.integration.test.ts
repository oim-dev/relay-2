import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { KnowledgeService } from "@relay/core";
import { decodeSnapshot } from "../../src/snapshot/codec";
import { git, requireGit } from "../../src/transport/git";
import { DataRepository } from "../../src/transport/repository";
import { withGitRepository } from "./helpers/git-repository-fixture";
import { createLocalProject } from "./helpers/local-project";

describe("Linked worktree локального проекта", () => {
  test("pushInsteadOf не позволяет подтвердить push по другой fetch-истории", async () => {
    await withGitRepository(async (remoteRepository, root, env) => {
      const project = await createLocalProject(
        join(root, "project"),
        remoteRepository.options.remote,
        env,
      );
      try {
        const other = join(root, "other.git");
        requireGit(await git(root, ["init", "--bare", other], { env }), "other-remote");
        requireGit(
          await git(
            project.root,
            ["config", `url.${other}.pushInsteadOf`, remoteRepository.options.remote],
            { env },
          ),
          "rewrite-push",
        );
        const head = await project.repository.commit(
          new Map([["record.json", Buffer.from("{}\n")]]),
          null,
        );

        await expect(project.repository.fetch()).rejects.toMatchObject({
          code: "GIT_ORIGIN_MISMATCH",
        });
        await expect(project.repository.push(head)).rejects.toMatchObject({
          code: "GIT_ORIGIN_MISMATCH",
        });

        expect(
          (await git(other, ["show-ref", "--verify", "--quiet", "refs/heads/relay-data"], { env }))
            .exitCode,
        ).toBe(1);
      } finally {
        project.database.close();
      }
    });
  }, 30_000);

  test("новый replicaId того же проекта использует свой namespace без присвоения старых refs", async () => {
    await withGitRepository(async (remoteRepository, root, env) => {
      const project = await createLocalProject(
        join(root, "project"),
        remoteRepository.options.remote,
        env,
      );
      try {
        const head = await project.repository.commit(
          new Map([["record.json", Buffer.from("{}\n")]]),
          null,
        );
        await project.repository.accepted(head);
        const replacement = new DataRepository({
          ...project.repository.options,
          worktree: {
            projectDirectory: project.root,
            projectId: project.location.projectId,
            replicaId: "replacement-replica",
          },
        });

        await replacement.initialize();

        expect(await replacement.acceptedCommit()).toBeNull();
        await replacement.accepted(head);
        expect(await replacement.acceptedCommit()).toBe(head);
        const originalReplica = project.replication.status().replicaId;
        const accepted = requireGit(
          await git(
            project.root,
            [
              "rev-parse",
              "refs/relay/replacement-replica/accepted",
              `refs/relay/${originalReplica}/accepted`,
            ],
            { env },
          ),
          "replica-refs",
        ).split("\n");
        expect(accepted).toEqual([head, head]);
      } finally {
        project.database.close();
      }
    });
  }, 30_000);

  test("существующий worktree той же ветки без маркера Relay не присваивается реплике", async () => {
    await withGitRepository(async (remoteRepository, root, env) => {
      const source = join(root, "source");
      const directory = join(source, ".relay", "data");
      mkdirSync(source);
      requireGit(await git(source, ["init", "--initial-branch=main", "."], { env }), "source-init");
      requireGit(
        await git(source, ["worktree", "add", "--orphan", "-b", "relay-data", directory], { env }),
        "foreign-worktree",
      );
      const link = readFileSync(join(directory, ".git"), "utf8");
      const repository = new DataRepository({
        directory,
        remote: remoteRepository.options.remote,
        branch: "relay-data",
        worktree: {
          projectDirectory: source,
          projectId: "fixture-project",
          replicaId: "new-replica",
        },
        env,
      });

      await expect(repository.initialize()).rejects.toMatchObject({
        code: "GIT_SYNC_WORKTREE_MISMATCH",
      });

      expect(readFileSync(join(directory, ".git"), "utf8")).toBe(link);
      expect(existsSync(join(source, ".git", "worktrees", "data", "relay-project"))).toBe(false);
    });
  }, 30_000);

  test("одноимённая локальная ветка кода не превращается в ветку данных", async () => {
    await withGitRepository(async (remoteRepository, root, env) => {
      const source = join(root, "source");
      const directory = join(source, ".relay", "data");
      mkdirSync(source);
      requireGit(await git(source, ["init", "--initial-branch=main", "."], { env }), "source-init");
      writeFileSync(join(source, "code.txt"), "код\n");
      requireGit(await git(source, ["add", "code.txt"], { env }), "source-add");
      requireGit(await git(source, ["commit", "-m", "Исходный код"], { env }), "source-commit");
      const head = requireGit(await git(source, ["rev-parse", "HEAD"], { env }), "source-head");
      requireGit(await git(source, ["branch", "relay-data"], { env }), "foreign-branch");
      const repository = new DataRepository({
        directory,
        remote: remoteRepository.options.remote,
        branch: "relay-data",
        worktree: {
          projectDirectory: source,
          projectId: "fixture-project",
          replicaId: "new-replica",
        },
        env,
      });

      await expect(repository.initialize()).rejects.toMatchObject({
        code: "GIT_SYNC_WORKTREE_MISMATCH",
      });

      expect(
        requireGit(await git(source, ["rev-parse", "relay-data"], { env }), "foreign-head"),
      ).toBe(head);
      expect(existsSync(directory)).toBe(false);
    });
  }, 30_000);

  test("hooks общего репозитория не запускаются транспортом linked worktree", async () => {
    await withGitRepository(async (remoteRepository, root, env) => {
      const source = join(root, "source");
      mkdirSync(source);
      requireGit(await git(source, ["init", "--initial-branch=main", "."], { env }), "source-init");
      const hooks = join(source, ".git", "hooks");
      for (const name of ["post-checkout", "reference-transaction"]) {
        writeFileSync(join(hooks, name), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
      }
      const repository = new DataRepository({
        directory: join(source, ".relay", "data"),
        remote: remoteRepository.options.remote,
        branch: "relay-data",
        worktree: {
          projectDirectory: source,
          projectId: "fixture-project",
          replicaId: "hook-replica",
        },
        env,
      });

      await repository.initialize();
      const files = new Map([["record.json", Buffer.from("{}\n")]]);
      const head = await repository.commit(files, null);
      await repository.accepted(head);

      expect(await repository.files(head)).toEqual(files);
      expect(await repository.acceptedCommit()).toBe(head);
    });
  }, 30_000);

  test("отменённый attempt не создаёт worktree", async () => {
    await withGitRepository(async (remoteRepository, root, env) => {
      const source = join(root, "source");
      mkdirSync(source);
      requireGit(await git(source, ["init", "--initial-branch=main", "."], { env }), "source-init");
      const directory = join(source, ".relay", "data");
      const repository = new DataRepository({
        directory,
        remote: remoteRepository.options.remote,
        branch: "relay-data",
        worktree: {
          projectDirectory: source,
          projectId: "fixture-project",
          replicaId: "cancelled-replica",
        },
        env,
      });
      repository.setAttemptSignal(AbortSignal.abort());

      await expect(repository.initialize()).rejects.toMatchObject({ code: "GIT_CANCELLED" });

      expect(existsSync(directory)).toBe(false);
    });
  }, 30_000);

  test("чужая gitdir-ссылка отклоняется до repair и остаётся неизменной", async () => {
    await withGitRepository(async (remoteRepository, root, env) => {
      const project = await createLocalProject(
        join(root, "project"),
        remoteRepository.options.remote,
        env,
      );
      try {
        const foreign = join(root, "foreign");
        mkdirSync(foreign);
        requireGit(
          await git(foreign, ["init", "--initial-branch=main", "."], { env }),
          "foreign-init",
        );
        requireGit(
          await git(
            foreign,
            ["worktree", "add", "--orphan", "-b", "relay-data", join(foreign, "data")],
            { env },
          ),
          "foreign-worktree",
        );
        const link = readFileSync(join(foreign, "data", ".git"), "utf8");
        const targetLink = join(project.repository.options.directory, ".git");
        writeFileSync(targetLink, link);
        const backlink = readFileSync(join(foreign, ".git", "worktrees", "data", "gitdir"), "utf8");

        await expect(
          new DataRepository(project.repository.options).initialize(),
        ).rejects.toMatchObject({ code: "GIT_SYNC_WORKTREE_MISMATCH" });

        expect(readFileSync(targetLink, "utf8")).toBe(link);
        expect(readFileSync(join(foreign, ".git", "worktrees", "data", "gitdir"), "utf8")).toBe(
          backlink,
        );
      } finally {
        project.database.close();
      }
    });
  }, 30_000);

  test("ignored-файл не перезаписывается новым снимком", async () => {
    await withGitRepository(async (remoteRepository, root, env) => {
      const project = await createLocalProject(
        join(root, "project"),
        remoteRepository.options.remote,
        env,
      );
      try {
        writeFileSync(join(project.root, ".git", "info", "exclude"), "collision.txt\n");
        const path = join(project.repository.options.directory, "collision.txt");
        writeFileSync(path, "пользовательский файл\n");

        await expect(
          project.repository.commit(new Map([["collision.txt", Buffer.from("снимок\n")]]), null),
        ).rejects.toMatchObject({ code: "GIT_SYNC_WORKTREE_DIRTY" });

        expect(readFileSync(path, "utf8")).toBe("пользовательский файл\n");
        expect(await project.repository.acceptedCommit()).toBeNull();
      } finally {
        project.database.close();
      }
    });
  }, 30_000);

  test("смена ветки после initialize не разрешает reset чужой ветки", async () => {
    await withGitRepository(async (remoteRepository, root, env) => {
      const project = await createLocalProject(
        join(root, "project"),
        remoteRepository.options.remote,
        env,
      );
      try {
        const directory = project.repository.options.directory;
        requireGit(
          await git(directory, ["symbolic-ref", "HEAD", "refs/heads/foreign"], { env }),
          "replace-head",
        );

        await expect(
          project.repository.commit(new Map([["record.json", Buffer.from("{}")]]), null),
        ).rejects.toMatchObject({ code: "GIT_SYNC_WORKTREE_MISMATCH" });

        expect(
          (
            await git(project.root, ["show-ref", "--verify", "--quiet", "refs/heads/foreign"], {
              env,
            })
          ).exitCode,
        ).toBe(1);
        expect(existsSync(join(directory, "record.json"))).toBe(false);
      } finally {
        project.database.close();
      }
    });
  }, 30_000);

  test("перенос целого проекта восстанавливает только собственные worktree-ссылки", async () => {
    await withGitRepository(async (remoteRepository, root, env) => {
      const project = await createLocalProject(
        join(root, "project"),
        remoteRepository.options.remote,
        env,
      );
      let head: string;
      const replicaId = project.replication.status().replicaId;
      try {
        head = await project.repository.commit(
          new Map([["record.json", Buffer.from("{}\n")]]),
          null,
        );
        await project.repository.accepted(head);
      } finally {
        project.database.close();
      }
      const moved = join(root, "moved");
      renameSync(project.root, moved);
      const repository = new DataRepository({
        ...project.repository.options,
        directory: join(moved, "home", "projects", project.location.projectId, "data"),
        worktree: { projectDirectory: moved, projectId: project.location.projectId, replicaId },
      });

      await repository.initialize();

      expect(await repository.acceptedCommit()).toBe(head);
      expect(readFileSync(join(repository.options.directory, "record.json"), "utf8")).toBe("{}\n");
      expect(requireGit(await git(moved, ["symbolic-ref", "HEAD"], { env }), "source-head")).toBe(
        "refs/heads/main",
      );
    });
  }, 30_000);

  test("autocrlf и глобальный smudge не преобразуют служебный checkout", async () => {
    await withGitRepository(async (remoteRepository, root, env) => {
      const project = await createLocalProject(
        join(root, "project"),
        remoteRepository.options.remote,
        env,
      );
      try {
        const attributes = join(root, "attributes");
        writeFileSync(attributes, "*.md filter=fail text eol=crlf\n");
        for (const [key, value] of [
          ["core.attributesFile", attributes],
          ["core.autocrlf", "true"],
          ["filter.fail.smudge", "false"],
          ["filter.fail.required", "true"],
        ] as const) {
          requireGit(await git(project.root, ["config", key, value], { env }), "fixture-config");
        }
        const bytes = Buffer.from("точные байты\r\nUnicode 🥕\n");
        const files = new Map([["body.md", bytes]]);

        const head = await project.repository.commit(files, null);
        await project.repository.accepted(head);
        await new DataRepository(project.repository.options).initialize();

        expect(await project.repository.files(head)).toEqual(files);
        expect(readFileSync(join(project.repository.options.directory, "body.md"))).toEqual(bytes);
      } finally {
        project.database.close();
      }
    });
  }, 30_000);

  test("info/attributes отклоняется до запуска filter и изменения файлов", async () => {
    await withGitRepository(async (remoteRepository, root, env) => {
      const project = await createLocalProject(
        join(root, "project"),
        remoteRepository.options.remote,
        env,
      );
      try {
        writeFileSync(join(project.root, ".git", "info", "attributes"), "*.md filter=fail\n");
        requireGit(
          await git(project.root, ["config", "filter.fail.smudge", "false"], { env }),
          "fixture-filter",
        );
        requireGit(
          await git(project.root, ["config", "filter.fail.required", "true"], { env }),
          "fixture-filter",
        );

        await expect(
          project.repository.commit(new Map([["body.md", Buffer.from("текст\n")]]), null),
        ).rejects.toMatchObject({ code: "GIT_SYNC_WORKTREE_ATTRIBUTES" });

        expect(existsSync(join(project.repository.options.directory, "body.md"))).toBe(false);
        expect(
          (
            await git(project.root, ["show-ref", "--verify", "--quiet", "refs/heads/relay-data"], {
              env,
            })
          ).exitCode,
        ).toBe(1);
      } finally {
        project.database.close();
      }
    });
  }, 30_000);

  test("данные не меняют commit, staged/unstaged код и private refs другой реплики", async () => {
    await withGitRepository(async (remoteRepository, root, env) => {
      const project = await createLocalProject(
        join(root, "project"),
        remoteRepository.options.remote,
        env,
      );
      try {
        const code = join(project.root, "code.txt");
        writeFileSync(code, "исходный код\n");
        requireGit(await git(project.root, ["add", "code.txt"], { env }), "code-add");
        requireGit(
          await git(project.root, ["commit", "-m", "Код проекта"], { env }),
          "code-commit",
        );
        const codeHead = requireGit(
          await git(project.root, ["rev-parse", "HEAD"], { env }),
          "code-head",
        );
        const foreignRefs = ["local", "remote", "accepted", "prepared"].map(
          (name) => `refs/relay/another-replica/${name}`,
        );
        requireGit(
          await git(project.root, ["update-ref", "--stdin"], {
            env,
            input: foreignRefs.map((ref) => `update ${ref} ${codeHead}\n`).join(""),
          }),
          "foreign-refs",
        );
        writeFileSync(code, "staged код\n");
        requireGit(await git(project.root, ["add", "code.txt"], { env }), "code-stage");
        const index = readFileSync(join(project.root, ".git", "index"));
        writeFileSync(code, "ещё не staged\n");

        await project.engine.run();

        expect(
          requireGit(await git(project.root, ["rev-parse", "HEAD"], { env }), "code-head"),
        ).toBe(codeHead);
        expect(readFileSync(join(project.root, ".git", "index"))).toEqual(index);
        expect(readFileSync(code, "utf8")).toBe("ещё не staged\n");
        expect(
          requireGit(
            await git(project.root, ["rev-parse", ...foreignRefs], { env }),
            "foreign-refs",
          ).split("\n"),
        ).toEqual(foreignRefs.map(() => codeHead));
        const head = await project.repository.acceptedCommit();
        expect(head).not.toBeNull();
        if (head === null) {
          throw new Error("Ожидался принятый Git commit");
        }
        const replica = project.replication.status().replicaId;
        expect(
          requireGit(
            await git(
              project.root,
              [
                "rev-parse",
                ...["local", "remote", "accepted"].map((name) => `refs/relay/${replica}/${name}`),
              ],
              { env },
            ),
            "own-refs",
          ).split("\n"),
        ).toEqual([head, head, head]);
      } finally {
        project.database.close();
      }
    });
  }, 30_000);

  test("первый push из пустого репозитория создаёт независимую историю данных и сохраняет HEAD/index кода", async () => {
    await withGitRepository(async (remoteRepository, root, env) => {
      const project = await createLocalProject(
        join(root, "project"),
        remoteRepository.options.remote,
        env,
      );
      try {
        const body = "Первая строка\r\n\tточные байты 🥕\n";
        const document = await new KnowledgeService(project.database).create(
          "document",
          { name: "Документ", body },
          "author",
        );
        const sourceIndex = requireGit(
          await git(project.root, ["ls-files"], { env }),
          "source-index",
        );

        await project.engine.run();

        const head = await project.repository.fetch();
        expect(head).not.toBeNull();
        if (head === null) {
          throw new Error("Ожидалась первая публикация");
        }
        const snapshot = decodeSnapshot(await project.repository.files(head));
        expect(
          snapshot.entities.find((entry) => entry.record.id === document.id)?.record.data.body,
        ).toBe(body);
        expect(project.replication.status().pending).toBe(0);
        expect(
          requireGit(await git(project.root, ["symbolic-ref", "HEAD"], { env }), "source-head"),
        ).toBe("refs/heads/main");
        expect(requireGit(await git(project.root, ["ls-files"], { env }), "source-index")).toBe(
          sourceIndex,
        );
        expect(
          requireGit(
            await git(project.root, ["rev-list", "--parents", "relay-data"], { env }),
            "data-parents",
          ),
        ).toBe(head);
        expect(
          requireGit(
            await git(project.repository.options.directory, ["rev-parse", "--is-bare-repository"], {
              env,
            }),
            "worktree-mode",
          ),
        ).toBe("false");
        expect(readFileSync(join(project.repository.options.directory, ".git"), "utf8")).toContain(
          "gitdir:",
        );
        expect(existsSync(join(project.repository.options.directory, "manifest.json"))).toBe(true);
        expect(project.location.databasePath).toBe(
          join(project.root, "home", "projects", project.location.projectId, "project.sqlite"),
        );
        expect(project.repository.options.directory).toBe(
          join(dirname(project.location.databasePath), "data"),
        );
        expect(existsSync(join(project.root, ".relay"))).toBe(false);
        expect(existsSync(join(project.root, ".gitignore"))).toBe(false);
      } finally {
        project.database.close();
      }
    });
  }, 30_000);

  test("две независимые SQLite обмениваются через общую ветку и собственные worktree", async () => {
    await withGitRepository(async (remoteRepository, root, env) => {
      const first = await createLocalProject(
        join(root, "first"),
        remoteRepository.options.remote,
        env,
      );
      try {
        await first.engine.run();
        const checkpoint = first.replication.acceptedSnapshot();
        if (checkpoint === null) {
          throw new Error("Нет принятого checkpoint");
        }
        const second = await createLocalProject(
          join(root, "second"),
          remoteRepository.options.remote,
          env,
          checkpoint,
        );
        try {
          const document = await new KnowledgeService(second.database).create(
            "document",
            { name: "Со второй реплики", body: "Доставлен через worktree" },
            "second",
          );

          await second.engine.run();
          await first.engine.run();

          expect(first.database.get(document.id)?.data.body).toBe("Доставлен через worktree");
          expect(first.replication.status().pending).toBe(0);
          expect(second.replication.status().pending).toBe(0);
          expect(first.replication.status().replicaId).not.toBe(
            second.replication.status().replicaId,
          );
          expect(await first.repository.fetch()).toBe(await second.repository.fetch());
        } finally {
          second.database.close();
        }
      } finally {
        first.database.close();
      }
    });
  }, 30_000);

  test("ручная правка служебного дерева отклоняет запуск с сохранением файла и pending", async () => {
    await withGitRepository(async (remoteRepository, root, env) => {
      const project = await createLocalProject(
        join(root, "project"),
        remoteRepository.options.remote,
        env,
      );
      try {
        await project.engine.run();
        const document = await new KnowledgeService(project.database).create(
          "document",
          { name: "В очереди", body: "Локальный текст" },
          "author",
        );
        const manifest = join(project.repository.options.directory, "manifest.json");
        writeFileSync(manifest, "ручная правка\n");
        const pending = project.replication.status().pending;

        await expect(
          new DataRepository(project.repository.options).initialize(),
        ).rejects.toMatchObject({ code: "GIT_SYNC_WORKTREE_DIRTY" });

        expect(readFileSync(manifest, "utf8")).toBe("ручная правка\n");
        expect(project.replication.status().pending).toBe(pending);
        expect(project.database.get(document.id)?.data.name).toBe("В очереди");
      } finally {
        project.database.close();
      }
    });
  }, 30_000);
});
