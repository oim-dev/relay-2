import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { runGuardedCommand } from "@relay/project-runtime";
import { withProcessFixture } from "./process-fixture";
import { startTestSupervisor } from "./supervisor-fixture";
import { readConfiguration, stateDirectory, updateConfiguration } from "../../src/local/state";
import { readEndpoint, responsive } from "../../src/local/control";

describe("Supervisor как единственный broker persistent workers", () => {
  test("вторая привязка запускает ту же physical DB после удаления первого config", async () => {
    await withProcessFixture(async (fixture) => {
      const first = fixture.context("first-binding");
      if (!first.location) {
        throw new Error("expected fixture project");
      }
      expect((await fixture.request(first.options, "connect", { remote: fixture.remote })).ok).toBe(
        true,
      );
      const second = join(fixture.root, "second-binding");
      mkdirSync(second);
      writeFileSync(
        join(second, "relay.config.json"),
        JSON.stringify({
          version: 1,
          projectId: first.location.projectId,
          databasePath: first.location.databasePath,
        }),
      );
      rmSync(first.location.configPath);
      const options = { ...first.options, cwd: second };
      const supervisor = await startTestSupervisor(fixture.binary, options);
      try {
        const started = await fixture.request(options, "worker.start");
        expect(started).toMatchObject({
          ok: true,
          data: {
            projectId: first.location.projectId,
            worker: { responsive: true, supervisorInstance: supervisor.endpoint.instance },
          },
        });
        const path = join(stateDirectory(first.location.databasePath), "worker.json");
        const before = readEndpoint(path);
        expect(before?.identity).toBe(first.location.databasePath);
        expect((await fixture.request(options, "worker.restart")).ok).toBe(true);
        expect(readEndpoint(path)?.identity).toBe(first.location.databasePath);
        expect(readEndpoint(path)?.instance).not.toBe(before?.instance);
      } finally {
        await supervisor.stop();
      }
    });
  }, 30_000);

  test("auto.enable без S не меняет mode/desired и не создаёт worker", async () => {
    await withProcessFixture(async (fixture) => {
      const project = fixture.context("without-supervisor");
      if (!project.location) {
        throw new Error("expected fixture project");
      }
      expect(
        (await fixture.request(project.options, "connect", { remote: fixture.remote })).ok,
      ).toBe(true);
      const directory = stateDirectory(project.location.databasePath);
      const before = readConfiguration(directory);

      const result = await fixture.request(project.options, "auto.enable");

      expect(result).toMatchObject({
        ok: false,
        error: { code: "SUPERVISOR_REQUIRED", exitCode: 4 },
      });
      expect(readConfiguration(directory)).toEqual(before);
      expect(readEndpoint(join(directory, "worker.json"))).toBeNull();
    });
  }, 20_000);

  test("W переживает strict cleanup request job, поскольку создан отдельным S", async () => {
    await withProcessFixture(async (fixture) => {
      const project = fixture.context("supervised");
      if (!project.location) {
        throw new Error("expected fixture project");
      }
      expect(
        (await fixture.request(project.options, "connect", { remote: fixture.remote })).ok,
      ).toBe(true);
      const supervisor = await startTestSupervisor(fixture.binary, project.options);
      try {
        const result = await runGuardedCommand({
          component: [fixture.binary],
          argv: [fixture.binary, "--request"],
          cwd: project.options.cwd,
          env: { ...process.env },
          input: JSON.stringify({
            version: 1,
            action: "worker.start",
            options: project.options,
            input: {},
          }),
          timeoutMs: 30_000,
          maxOutputBytes: 1024 * 1024,
        });

        expect(result.code).toBe(0);
        expect(JSON.parse(Buffer.from(result.stdout).toString())).toMatchObject({
          ok: true,
          data: {
            worker: {
              actual: "running",
              responsive: true,
              supervisorInstance: supervisor.endpoint.instance,
            },
          },
        });
        const endpoint = readEndpoint(
          join(stateDirectory(project.location.databasePath), "worker.json"),
        );
        expect(endpoint).not.toBeNull();
        if (endpoint) {
          expect(await responsive(endpoint)).toBe(true);
        }
      } finally {
        await supervisor.stop();
      }
    });
  }, 30_000);

  test("ошибка startup после ready S сохраняет прежние предпочтения", async () => {
    await withProcessFixture(async (fixture) => {
      const project = fixture.context("failed-start");
      if (!project.location) {
        throw new Error("expected fixture project");
      }
      expect(
        (await fixture.request(project.options, "connect", { remote: fixture.remote })).ok,
      ).toBe(true);
      const directory = stateDirectory(project.location.databasePath);
      updateConfiguration(directory, (current) => {
        if (!current) {
          throw new Error("missing connection");
        }
        return { ...current, projectId: "different-project" };
      });
      const before = readConfiguration(directory);
      const supervisor = await startTestSupervisor(fixture.binary, project.options);
      try {
        const result = await fixture.request(project.options, "auto.enable");

        expect(result).toMatchObject({
          ok: false,
          error: { code: "GIT_PROJECT_MISMATCH", exitCode: 4 },
        });
        expect(readConfiguration(directory)).toEqual(before);
        expect(readEndpoint(join(directory, "worker.json"))).toBeNull();
      } finally {
        await supervisor.stop();
      }
    });
  }, 30_000);
});
