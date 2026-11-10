import { describe, expect, spyOn, test } from "bun:test";
import { withGitRepository } from "./helpers/git-repository-fixture";
import { git, requireGit } from "../../src/transport/git";
import * as commands from "../../src/transport/git";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GitHistoryEntry } from "../../src/transport/repository.types";

describe("Пакетное чтение canonical Git history", () => {
  test("shallow boundary не скрывает реального parent и не превращается в ложный genesis", async () => {
    await withGitRepository(async (repository) => {
      const first = await repository.commit(new Map([["manifest.json", Buffer.from("{}")]]), null);
      const next = await repository.commit(
        new Map([["manifest.json", Buffer.from('{"next":true}')]]),
        first,
      );
      writeFileSync(join(repository.options.directory, "shallow"), next + "\n");

      await expect(repository.history(next, null)).rejects.toMatchObject({
        code: "GIT_UNRELATED_HISTORY",
      });
    });
  }, 15_000);

  test("промежуточные snapshots читаются общей пачкой и разделяют неизменённые blobs", async () => {
    await withGitRepository(async (repository) => {
      const stable = Buffer.from("# Точный текст\r\n\tбез изменений  \n");
      const commits: string[] = [];
      const expected: GitHistoryEntry[] = [];
      let parent: string | null = null;
      for (let index = 0; index < 4; index++) {
        const head = await repository.commit(
          new Map([
            ["manifest.json", Buffer.from('{"formatVersion":1}')],
            ["entities/stable/body.md", stable],
            ["entities/changing/value.json", Buffer.from(JSON.stringify({ index }))],
          ]),
          parent,
        );
        commits.push(head);
        expected.push({ head, parent });
        parent = head;
      }
      if (!parent || !commits[0] || !commits[1]) {
        throw new Error("missing fixture history");
      }
      const history = await repository.history(parent, commits[0]);
      expect(history).toEqual(expected.slice(1));
      expect(await repository.history(parent, null)).toEqual(expected);
      expect(expected[0]?.parent).toBeNull();
      expect(history.some((entry) => entry.parent === null)).toBe(false);
      const invocation = spyOn(commands, "git");
      try {
        await repository.filesMany([parent]);
        const one = invocation.mock.calls.length;
        invocation.mockClear();

        const snapshots = await repository.filesMany(commits);
        const many = invocation.mock.calls.length;

        expect(one).toBeGreaterThan(0);
        expect(many).toBeLessThanOrEqual(one + 1);
        for (const [index, head] of commits.entries()) {
          expect(
            Buffer.from(snapshots.get(head)?.get("entities/changing/value.json") ?? []).toString(),
          ).toBe(JSON.stringify({ index }));
          expect(snapshots.get(head)?.get("entities/stable/body.md")).toEqual(stable);
        }
        expect(snapshots.get(commits[0])?.get("entities/stable/body.md")).toBe(
          snapshots.get(parent)?.get("entities/stable/body.md"),
        );
      } finally {
        invocation.mockRestore();
      }
    });
  }, 20_000);

  test("merge commit не прячется за first-parent и отвергается как нелинейная canonical history", async () => {
    await withGitRepository(async (repository, _root, env) => {
      const first = await repository.commit(new Map([["manifest.json", Buffer.from("{}")]]), null);
      const next = await repository.commit(
        new Map([["manifest.json", Buffer.from('{"next":true}')]]),
        first,
      );
      const other = await repository.commit(
        new Map([["manifest.json", Buffer.from('{"other":true}')]]),
        first,
      );
      const tree = requireGit(
        await git(repository.options.directory, ["rev-parse", `${next}^{tree}`], { env }),
        "tree",
      );
      const merged = requireGit(
        await git(repository.options.directory, ["commit-tree", tree, "-p", next, "-p", other], {
          env,
          input: "Намеренно недопустимый merge\n",
        }),
        "merge",
      );

      await expect(repository.history(merged, first)).rejects.toMatchObject({
        code: "GIT_UNRELATED_HISTORY",
      });
    });
  }, 15_000);

  test("batch reader отвергает symlink до чтения/материализации цели", async () => {
    await withGitRepository(async (repository, _root, env) => {
      const blob = requireGit(
        await git(repository.options.directory, ["hash-object", "-w", "--stdin"], {
          env,
          input: "/посторонний/файл",
        }),
        "blob",
      );
      const tree = requireGit(
        await git(repository.options.directory, ["mktree"], {
          env,
          input: `120000 blob ${blob}\tmanifest.json\n`,
        }),
        "tree",
      );
      const commit = requireGit(
        await git(repository.options.directory, ["commit-tree", tree], {
          env,
          input: "Недопустимая ссылка\n",
        }),
        "commit",
      );

      await expect(repository.filesMany([commit])).rejects.toMatchObject({
        code: "GIT_INVALID_SNAPSHOT",
      });
    });
  }, 15_000);
});
