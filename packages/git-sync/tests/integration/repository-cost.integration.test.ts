import { describe, expect, spyOn, test } from "bun:test";
import { withGitRepository } from "./helpers/git-repository-fixture";
import { DataRepository } from "../../src/transport/repository";
import { git, requireGit } from "../../src/transport/git";
import * as commands from "../../src/transport/git";

describe("Ограниченная стоимость private Git plumbing", () => {
  test("повторный кандидат на прежнем parent и одинаковое дерево обходятся двумя Git без потери байтов", async () => {
    await withGitRepository(async (repository, _root, env) => {
      const original = new Map([["record.json", Buffer.from('{"initial":true}')]]);
      const base = await repository.commit(original, null);
      await repository.accepted(base);
      const invocation = spyOn(commands, "git");
      try {
        const firstFiles = new Map([["document/body.md", Buffer.from("Первая сторона\r\n\t")]]);
        const first = await repository.commit(firstFiles, base);
        expect(invocation).toHaveBeenCalledTimes(2);
        invocation.mockClear();

        const retryFiles = new Map([
          ["document/body.md", Buffer.from("Другая сторона\r\n\tбез LF")],
        ]);
        const retry = await repository.commit(retryFiles, base);
        expect(invocation).toHaveBeenCalledTimes(2);
        invocation.mockClear();
        const unchanged = await repository.commit(retryFiles, retry);
        expect(invocation).toHaveBeenCalledTimes(2);

        expect(first).not.toBe(retry);
        expect(unchanged).toBe(retry);
        expect(await repository.files(retry)).toEqual(retryFiles);
        expect(await repository.history(retry, base)).toEqual([{ head: retry, parent: base }]);
        expect(
          requireGit(
            await git(
              repository.options.directory,
              ["rev-parse", "refs/heads/data", "refs/relay/remote", "refs/relay/accepted"],
              { env },
            ),
            "observe-refs",
          ).split("\n"),
        ).toEqual([retry, base, base]);

        invocation.mockClear();
        await expect(
          repository.commit(retryFiles, `${base}\nreset refs/relay/accepted`),
        ).rejects.toMatchObject({
          code: "GIT_INVALID_SNAPSHOT",
        });
        expect(invocation).not.toHaveBeenCalled();
        expect(await repository.ref("refs/heads/data")).toBe(retry);
      } finally {
        invocation.mockRestore();
      }
    });
  }, 15_000);

  test("холодное чтение refs одним Git сохраняет отсутствие и отставший accepted cursor", async () => {
    await withGitRepository(async (repository) => {
      const invocation = spyOn(commands, "git");
      try {
        expect(
          await Promise.all([
            repository.ref("refs/heads/data"),
            repository.ref("refs/relay/remote"),
            repository.acceptedCommit(),
          ]),
        ).toEqual([null, null, null]);
        expect(invocation).toHaveBeenCalledTimes(1);
        const base = await repository.commit(new Map([["state.json", Buffer.from("{}")]]), null);
        await repository.accepted(base);
        const next = await repository.commit(
          new Map([["state.json", Buffer.from('{"next":1}')]]),
          base,
        );
        await repository.rememberRemote(next);
        const reopened = new DataRepository(repository.options);
        invocation.mockClear();

        expect(
          await Promise.all([
            reopened.ref("refs/heads/data"),
            reopened.ref("refs/relay/remote"),
            reopened.acceptedCommit(),
          ]),
        ).toEqual([next, next, base]);
        expect(invocation).toHaveBeenCalledTimes(1);
        expect(await reopened.counts()).toEqual({
          localHead: next,
          remoteHead: next,
          ahead: 0,
          behind: 0,
        });
        expect(await reopened.acceptedCommit()).toBe(base);
        expect(invocation).toHaveBeenCalledTimes(1);
      } finally {
        invocation.mockRestore();
      }
    });
  }, 15_000);
});
