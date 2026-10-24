import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, renameSync } from "node:fs";
import { join } from "node:path";
import { initializeProject, type RuntimeOptions } from "@relay/project-runtime";
import { withProcessFixture, eventually } from "./process-fixture";
import { git, requireGit } from "../../src/transport/git";
import { executeAction } from "../../src/app/actions";
import { readEndpoint, responsive } from "../../src/local/control";
import { readConfiguration, stateDirectory } from "../../src/local/state";
import { startTestSupervisor } from "./supervisor-fixture";
import { readLocalJson } from "../../src/local/files";
import { requestObject } from "../../src/app/protocol";
import { running } from "./guardian-helpers/fixture";

/**
 * Читает результаты завершённого обхода только указанного lifetime S; старый cache не служит барьером.
 */
function reconciledProjects(home: string, instance: string): Record<string, unknown>[] | null {
  const value = readLocalJson(join(home, "git-sync", "supervisor-status.json"));
  if (value === undefined) {
    return null;
  }
  const status = requestObject(value);
  if (status.instance !== instance) {
    return null;
  }
  if (!Array.isArray(status.projects)) {
    throw new Error("Некорректный список проектов supervisor");
  }
  return status.projects.map(requestObject);
}

/**
 * Наблюдает публикацию в настоящем remote, отличая отсутствующую ветку от ошибки Git.
 */
async function hasPublishedBranch(remote: string): Promise<boolean> {
  const result = await git(remote, ["show-ref", "--verify", "--quiet", "refs/heads/relay-data-v2"]);
  if (result.exitCode === 1) {
    return false;
  }
  requireGit(result, "проверка опубликованной ветки");
  return true;
}

describe("Постоянный supervisor изолированных проектов", () => {
  test("шесть проектов обслуживаются при бюджете четыре, crash worker восстанавливается, новый S сохраняет stopped и обслуживает running", async () => {
    await withProcessFixture(async (fixture) => {
      const home = join(fixture.root, "supervised-home");
      mkdirSync(home);
      const projects: { options: RuntimeOptions; databasePath: string; remote: string }[] = [];
      for (let index = 0; index < 7; index++) {
        const cwd = join(fixture.root, `supervised-${index}`);
        const remote = join(fixture.root, `remote-${index}.git`);
        mkdirSync(cwd);
        requireGit(await git(cwd, ["init", "--bare", remote]), "remote");
        const options = { cwd, home };
        const location = initializeProject({ ...options, name: `project-${index}` });
        expect((await fixture.request(options, "connect", { remote })).ok).toBe(true);
        projects.push({ options, databasePath: realpathSync(location.databasePath), remote });
      }
      const broken = projects[6];
      if (!broken) {
        throw new Error("missing broken project");
      }
      renameSync(broken.remote, broken.remote + "-offline");
      const supervisorPath = join(home, "git-sync", "supervisor.json");
      let supervisor = await startTestSupervisor(fixture.binary, { cwd: fixture.root, home });
      const initialSupervisor = supervisor.endpoint;
      const pids = new Set([initialSupervisor.pid]);
      try {
        expect(initialSupervisor.identity).toBe(realpathSync(home));
        for (const project of projects) {
          expect((await fixture.request(project.options, "auto.enable")).ok).toBe(true);
        }
        await eventually(async () => {
          const results = await Promise.all(
            projects.slice(0, 6).map((project) => hasPublishedBranch(project.remote)),
          );
          return results.every(Boolean);
        }, 20_000);
        for (const project of projects) {
          const endpoint = readEndpoint(join(stateDirectory(project.databasePath), "worker.json"));
          expect(endpoint).not.toBeNull();
          if (endpoint) {
            pids.add(endpoint.pid);
            expect(endpoint.identity).toBe(project.databasePath);
            expect(endpoint.supervisorInstance).toBe(initialSupervisor.instance);
            expect(await responsive(endpoint)).toBe(true);
          }
        }
        const first = projects[0];
        if (!first) {
          throw new Error("missing first");
        }
        const endpointPath = join(stateDirectory(first.databasePath), "worker.json");
        const before = readEndpoint(endpointPath);
        if (!before) {
          throw new Error("missing worker");
        }

        process.kill(before.pid, "SIGKILL");
        await eventually(async () => {
          const current = readEndpoint(endpointPath);
          return (
            current !== null && current.instance !== before.instance && (await responsive(current))
          );
        });
        const recovered = readEndpoint(endpointPath);
        if (!recovered) {
          throw new Error("Нет восстановленного worker");
        }
        pids.add(recovered.pid);
        expect(recovered.identity).toBe(first.databasePath);
        expect(recovered.supervisorInstance).toBe(initialSupervisor.instance);
        expect((await fixture.request(first.options, "worker.stop")).ok).toBe(true);
        await eventually(
          () =>
            reconciledProjects(home, initialSupervisor.instance)?.some(
              (project) =>
                project.databasePath === first.databasePath && project.actual === "stopped",
            ) === true,
        );
        const stoppedPreferences = readConfiguration(stateDirectory(first.databasePath));
        expect(stoppedPreferences).toMatchObject({
          databasePath: first.databasePath,
          mode: "auto",
          desired: "stopped",
        });
        expect(await fixture.request(first.options, "status")).toMatchObject({
          ok: true,
          data: { worker: { desired: "stopped", responsive: false } },
        });

        const runningPath = join(stateDirectory(broken.databasePath), "worker.json");
        const runningBefore = readEndpoint(runningPath);
        const runningPreferences = readConfiguration(stateDirectory(broken.databasePath));
        if (!runningBefore || !runningPreferences) {
          throw new Error("Нет desired-running проекта перед перезапуском supervisor");
        }
        expect(runningPreferences).toMatchObject({ desired: "running", mode: "auto" });

        await supervisor.stop();

        expect([...pids].filter(running)).toEqual([]);
        expect(readEndpoint(supervisorPath)).toBeNull();
        for (const project of projects) {
          expect(
            readEndpoint(join(stateDirectory(project.databasePath), "worker.json")),
          ).toBeNull();
        }
        expect(readConfiguration(stateDirectory(first.databasePath))).toEqual(stoppedPreferences);
        expect(readConfiguration(stateDirectory(broken.databasePath))).toEqual(runningPreferences);

        // Remote возвращается только после выхода прежнего дерева: первую публикацию сможет сделать новый W.
        renameSync(broken.remote + "-offline", broken.remote);
        expect(await hasPublishedBranch(broken.remote)).toBe(false);
        supervisor = await startTestSupervisor(fixture.binary, { cwd: fixture.root, home });
        pids.add(supervisor.endpoint.pid);
        expect(supervisor.endpoint.instance).not.toBe(initialSupervisor.instance);
        expect(supervisor.endpoint.identity).toBe(initialSupervisor.identity);

        // Readiness S предшествует reconcile; ждём запись полного обхода именно нового instance.
        await eventually(() => reconciledProjects(home, supervisor.endpoint.instance) !== null);
        const runningAfter = readEndpoint(runningPath);
        if (!runningAfter) {
          throw new Error("Новый supervisor не восстановил desired-running worker");
        }
        expect(reconciledProjects(home, supervisor.endpoint.instance)).toEqual(
          expect.arrayContaining([
            { databasePath: first.databasePath, actual: "stopped" },
            {
              databasePath: broken.databasePath,
              actual: "running",
              instance: runningAfter.instance,
            },
          ]),
        );
        expect(runningAfter.instance).not.toBe(runningBefore.instance);
        expect(runningAfter.identity).toBe(broken.databasePath);
        expect(runningAfter.supervisorInstance).toBe(supervisor.endpoint.instance);
        expect(await responsive(runningAfter)).toBe(true);
        for (const project of projects.slice(1)) {
          const endpoint = readEndpoint(join(stateDirectory(project.databasePath), "worker.json"));
          expect(endpoint?.supervisorInstance).toBe(supervisor.endpoint.instance);
          if (endpoint) {
            pids.add(endpoint.pid);
          }
        }

        await eventually(() => hasPublishedBranch(broken.remote), 20_000);
        const manifest = requireGit(
          await git(broken.remote, ["show", "refs/heads/relay-data-v2:manifest.json"]),
          "публикация восстановленного worker",
        );
        expect(JSON.parse(manifest)).toMatchObject({ projectId: runningPreferences.projectId });
        expect(readEndpoint(endpointPath)).toBeNull();
        expect(readConfiguration(stateDirectory(first.databasePath))).toEqual(stoppedPreferences);
        expect(readConfiguration(stateDirectory(broken.databasePath))).toEqual(runningPreferences);
        expect(await fixture.request(first.options, "status")).toMatchObject({
          ok: true,
          data: {
            databaseIdentity: first.databasePath,
            worker: { desired: "stopped", actual: "stopped", responsive: false, instance: null },
          },
        });
      } finally {
        try {
          await supervisor.stop();
          expect([...pids].filter(running)).toEqual([]);
          expect(readEndpoint(supervisorPath)).toBeNull();
          for (const project of projects) {
            expect(
              readEndpoint(join(stateDirectory(project.databasePath), "worker.json")),
            ).toBeNull();
          }
        } finally {
          await Promise.allSettled(
            projects.map((project) =>
              executeAction({ version: 1, action: "worker.stop", options: project.options }),
            ),
          );
        }
      }
    });
  }, 60_000);
});
