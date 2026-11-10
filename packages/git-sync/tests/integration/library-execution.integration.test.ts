import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { initializeProject } from "@relay/project-runtime";
import { executeGitSyncRequest } from "../../src/index";
import { git, requireGit } from "../../src/transport/git";
import { withGitRepository } from "./helpers/git-repository-fixture";

describe("Библиотечный вход Git Sync", () => {
  test("параллельные обращения используют origin из собственных снимков среды", async () => {
    await withGitRepository(async (repository, root, env) => {
      const secondRemote = join(root, "second.git");
      requireGit(await git(root, ["init", "--bare", secondRemote], { env }), "second-remote");
      const projects = [];
      for (const [name, remote] of [
        ["first", repository.options.remote],
        ["second", secondRemote],
      ] as const) {
        const cwd = join(root, name);
        mkdirSync(cwd);
        requireGit(await git(cwd, ["init", "--initial-branch=main", "."], { env }), "project-git");
        requireGit(
          await git(cwd, ["remote", "add", "origin", "relay-fixture://origin"], { env }),
          "project-origin",
        );
        const location = initializeProject({ cwd, home: join(cwd, "home"), name });
        const config = join(cwd, "gitconfig");
        writeFileSync(
          config,
          `[url ${JSON.stringify(remote)}]\n\tinsteadOf = relay-fixture://origin\n`,
        );
        projects.push({
          cwd,
          remote,
          location,
          env: { ...process.env, ...env, GIT_CONFIG_GLOBAL: config, HOME: cwd, USERPROFILE: cwd },
        });
      }
      for (const project of projects) {
        expect(
          requireGit(
            await git(project.cwd, ["remote", "get-url", "origin"], { env: project.env }),
            "configured-origin",
          ),
        ).toBe(project.remote);
      }
      const previous = process.env.GIT_CONFIG_GLOBAL;

      const results = await Promise.all(
        projects.map((project) =>
          executeGitSyncRequest(
            {
              version: 1,
              action: "now",
              options: { cwd: project.cwd, home: join(project.cwd, "home") },
            },
            { env: project.env },
          ),
        ),
      );

      for (const result of results) {
        expect(result).toMatchObject({ pending: { changesets: 0 }, branch: "relay-data" });
      }
      for (const project of projects) {
        const manifest = requireGit(
          await git(project.remote, ["show", "refs/heads/relay-data:manifest.json"], { env }),
          "remote-manifest",
        );
        expect(JSON.parse(manifest).projectId).toBe(project.location.projectId);
      }
      expect(projects[0]?.location.projectId).not.toBe(projects[1]?.location.projectId);
      expect(process.env.GIT_CONFIG_GLOBAL).toBe(previous);
    });
  }, 30_000);

  test("поздняя правка входного объекта не меняет ветку уже принятого connect", async () => {
    await withGitRepository(async (repository, root, env) => {
      const cwd = join(root, "project");
      mkdirSync(cwd);
      requireGit(await git(cwd, ["init", "--initial-branch=main", "."], { env }), "project-git");
      requireGit(
        await git(cwd, ["remote", "add", "origin", repository.options.remote], { env }),
        "project-origin",
      );
      const location = initializeProject({ cwd, home: join(cwd, "home"), name: "Снимок запроса" });
      const request = {
        version: 1 as const,
        action: "connect",
        options: { cwd, home: join(cwd, "home") },
        input: { remote: "origin", branch: "relay-data" },
      };

      const operation = executeGitSyncRequest(request, { env: { ...process.env, ...env } });
      request.input.branch = "changed-after-submit";
      const result = await operation;

      expect(result).toMatchObject({ connected: true, branch: "relay-data" });
      expect(
        requireGit(
          await git(join(dirname(location.databasePath), "data"), ["symbolic-ref", "HEAD"], {
            env,
          }),
          "data-head",
        ),
      ).toBe("refs/heads/relay-data");
    });
  }, 30_000);

  test("предварительная отмена сохраняет requestId до выбора отсутствующего проекта", async () => {
    const cancellation = new AbortController();
    cancellation.abort("SIGTERM");

    await expect(
      executeGitSyncRequest(
        {
          version: 1,
          action: "now",
          options: { cwd: "/nonexistent-relay-project" },
          input: { operationId: "cancelled-before-io" },
        },
        { env: {}, signal: cancellation.signal },
      ),
    ).rejects.toMatchObject({
      code: "GIT_SYNC_CANCELLED",
      exitCode: 143,
      details: { requestId: "cancelled-before-io", state: "unknown" },
    });
  });
});
