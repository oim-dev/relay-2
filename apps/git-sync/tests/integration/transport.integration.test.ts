import { describe, expect, spyOn, test } from "bun:test";
import { KnowledgeService } from "@relay/core";
import { withGitFixture } from "./helpers/git-fixture";
import { DataRepository } from "../../src/transport/repository";
import { git, requireGit } from "../../src/transport/git";
import { runProcess } from "../../src/transport/process";
import * as gitCommands from "../../src/transport/git";
import { encodeSnapshot } from "../../src/snapshot/codec";

describe("Защита private Git транспорта", () => {
  test("idle polling того же HEAD переиспользует snapshot, а новый changeset запускает подготовку", async () => {
    await withGitFixture(async (fixture) => {
      const replica = await fixture.replica("head-cache");
      await replica.engine.run();
      const files = spyOn(replica.repository, "files");
      const preparation = spyOn(replica.replication, "prepare");
      try {
        await replica.engine.run();
        await replica.engine.run();

        expect(files).not.toHaveBeenCalled();
        expect(preparation).not.toHaveBeenCalled();
        const document = await new KnowledgeService(replica.db).create(
          "document",
          { name: "После простоя", body: "новая операция" },
          "author",
        );
        await replica.engine.run();
        expect(preparation).toHaveBeenCalledTimes(1);
        expect(replica.replication.status().pending).toBe(0);
        expect(replica.db.get(document.id)?.data.body).toBe("новая операция");
      } finally {
        files.mockRestore();
        preparation.mockRestore();
      }
    });
  }, 15_000);

  test("число Git-процессов материализации и чтения не растёт с количеством карточек", async () => {
    await withGitFixture(async (fixture) => {
      const replica = await fixture.replica("batched-files");
      const small = encodeSnapshot(replica.replication.capture());
      const parent = await replica.repository.commit(small, null);
      for (let index = 0; index < 20; index++) {
        await new KnowledgeService(replica.db).create(
          "document",
          { name: `Документ ${index}`, body: `# Текст ${index}\r\n` },
          "author",
        );
      }
      const large = encodeSnapshot(replica.replication.capture());
      const invocations = spyOn(gitCommands, "git");
      try {
        const smallHead = await replica.repository.commit(small, parent);
        const smallWrites = invocations.mock.calls.length;
        invocations.mockClear();
        await replica.repository.files(smallHead);
        const smallReads = invocations.mock.calls.length;
        invocations.mockClear();

        const largeHead = await replica.repository.commit(large, parent);
        const largeWrites = invocations.mock.calls.length;
        invocations.mockClear();
        const restored = await replica.repository.files(largeHead);
        const largeReads = invocations.mock.calls.length;

        expect(large.size).toBeGreaterThan(small.size + 20);
        expect(restored).toEqual(large);
        expect(smallWrites).toBeGreaterThan(0);
        expect(smallReads).toBeGreaterThan(0);
        expect(largeWrites).toBeLessThanOrEqual(smallWrites + 1);
        expect(largeReads).toBeLessThanOrEqual(smallReads + 1);
      } finally {
        invocations.mockRestore();
      }
    });
  }, 15_000);

  test("изменённый origin не перезаписывается подключением", async () => {
    await withGitFixture(async (fixture) => {
      const replica = await fixture.replica("origin");
      requireGit(
        await git(replica.repository.options.directory, [
          "remote",
          "set-url",
          "origin",
          fixture.remote + "-other",
        ]),
        "tamper-origin",
      );

      await expect(replica.repository.initialize()).rejects.toMatchObject({
        code: "GIT_ORIGIN_MISMATCH",
      });

      expect(
        requireGit(
          await git(replica.repository.options.directory, ["remote", "get-url", "origin"]),
          "origin",
        ),
      ).toBe(fixture.remote + "-other");
      expect(replica.replication.core.status().pending).toBeGreaterThan(0);
    });
  });

  test("замена общей истории посторонним root отклоняется до apply и push", async () => {
    await withGitFixture(async (fixture) => {
      const replica = await fixture.replica("history");
      await replica.engine.run();
      const before = replica.replication.core.capture();
      const rogue = new DataRepository({
        ...replica.repository.options,
        directory: fixture.remote,
      });
      const unrelated = await rogue.commit(new Map([["unrelated.json", Buffer.from("{}")]]), null);
      requireGit(
        await git(fixture.remote, ["update-ref", "refs/heads/relay-data-v2", unrelated]),
        "rewrite-fixture",
      );

      await expect(replica.engine.run()).rejects.toMatchObject({ code: "GIT_UNRELATED_HISTORY" });

      expect(replica.replication.core.capture()).toEqual(before);
      expect(
        requireGit(await git(fixture.remote, ["rev-parse", "refs/heads/relay-data-v2"]), "head"),
      ).toBe(unrelated);
    });
  });

  test("symlink в Git tree отклоняется без checkout или чтения файлов по ссылке", async () => {
    await withGitFixture(async (fixture) => {
      const replica = await fixture.replica("symlink");
      const cwd = replica.repository.options.directory;
      const blob = requireGit(
        await git(cwd, ["hash-object", "-w", "--stdin"], { input: "/etc/passwd" }),
        "blob",
      );
      const tree = requireGit(
        await git(cwd, ["mktree"], { input: `120000 blob ${blob}\tmanifest.json\n` }),
        "tree",
      );

      await expect(replica.repository.files(tree)).rejects.toMatchObject({
        code: "GIT_INVALID_SNAPSHOT",
      });
    });
  });

  test("асинхронный runner читает оба потока, ограничивает вывод и завершает deadline", async () => {
    await withGitFixture(async (fixture) => {
      const output = await runProcess({
        executable: process.execPath,
        args: [
          "-e",
          'process.stdout.write("a".repeat(100000)); process.stderr.write("b".repeat(100000));',
        ],
        cwd: fixture.root,
        maxBytes: 200000,
      });

      expect(output.stdout.byteLength).toBe(100000);
      expect(output.stderr.byteLength).toBe(100000);
      await expect(
        runProcess({
          executable: process.execPath,
          args: ["-e", 'process.stdout.write("a".repeat(100000))'],
          cwd: fixture.root,
          maxBytes: 1000,
        }),
      ).rejects.toMatchObject({ code: "GIT_OUTPUT_LIMIT" });
      await expect(
        runProcess({
          executable: process.execPath,
          args: ["-e", "setInterval(() => {}, 1000)"],
          cwd: fixture.root,
          timeoutMs: 100,
        }),
      ).rejects.toMatchObject({ code: "GIT_TIMEOUT" });
    });
  });
});
