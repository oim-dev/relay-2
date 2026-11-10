import { describe, expect, spyOn, test } from "bun:test";
import { withGitRepository } from "./helpers/git-repository-fixture";
import * as commands from "../../src/transport/git";
import { git, requireGit } from "../../src/transport/git";

describe("Подтверждённые Git refs одной транзакцией", () => {
  test("direct candidate считает доказанное ребро, а смена remote возвращает точный Git rev-list", async () => {
    await withGitRepository(async (repository, _root, env) => {
      const base = await repository.commit(new Map([["manifest.json", Buffer.from("{}")]]), null);
      await repository.accepted(base);
      const first = await repository.commit(
        new Map([["manifest.json", Buffer.from('{"candidate":1}')]]),
        base,
      );
      const calls = spyOn(commands, "git");
      try {
        expect(await repository.counts()).toEqual({
          localHead: first,
          remoteHead: base,
          ahead: 1,
          behind: 0,
        });
        expect(calls).not.toHaveBeenCalled();
      } finally {
        calls.mockRestore();
      }
      expect(
        requireGit(
          await git(
            repository.options.directory,
            ["rev-list", "--left-right", "--count", `${first}...${base}`],
            { env },
          ),
          "actual-direct-counts",
        ),
      ).toBe("1\t0");
      const sibling = await repository.commit(
        new Map([["manifest.json", Buffer.from('{"candidate":2}')]]),
        base,
      );
      await repository.rememberRemote(first);

      expect(await repository.counts()).toEqual({
        localHead: sibling,
        remoteHead: first,
        ahead: 1,
        behind: 1,
      });
      expect(
        requireGit(
          await git(
            repository.options.directory,
            ["rev-list", "--left-right", "--count", `${sibling}...${first}`],
            { env },
          ),
          "actual-divergence",
        ),
      ).toBe("1\t1");
    });
  }, 15_000);

  test("accepted обновляет все refs одним plumbing вызовом, отказ не оставляет частичного cursor", async () => {
    await withGitRepository(async (repository, _root, env) => {
      const first = await repository.commit(new Map([["manifest.json", Buffer.from("{}")]]), null);
      await repository.accepted(first);
      const next = await repository.commit(
        new Map([["manifest.json", Buffer.from('{"next":true}')]]),
        first,
      );
      const calls = spyOn(commands, "git");
      try {
        await repository.accepted(next);

        expect(calls).toHaveBeenCalledTimes(1);
      } finally {
        calls.mockRestore();
      }
      expect(
        requireGit(
          await git(
            repository.options.directory,
            ["rev-parse", "refs/heads/data", "refs/relay/remote", "refs/relay/accepted"],
            { env },
          ),
          "actual-refs",
        ).split("\n"),
      ).toEqual([next, next, next]);

      await expect(repository.accepted("f".repeat(next.length))).rejects.toMatchObject({
        code: "GIT_FAILED",
      });

      expect(
        requireGit(
          await git(
            repository.options.directory,
            ["rev-parse", "refs/heads/data", "refs/relay/remote", "refs/relay/accepted"],
            { env },
          ),
          "unchanged-refs",
        ).split("\n"),
      ).toEqual([next, next, next]);
      expect(await repository.acceptedCommit()).toBe(next);
    });
  }, 15_000);
});
