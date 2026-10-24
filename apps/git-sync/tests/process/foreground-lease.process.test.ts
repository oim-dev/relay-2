import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { withProcessFixture, eventually } from "./process-fixture";
import { readEndpoint, responsive } from "../../src/local/control";
import { readConfiguration, stateDirectory, updateConfiguration } from "../../src/local/state";

describe("Lease foreground supervisor", () => {
  test("SIGKILL прокси закрывает stdin и завершает supervisor вместе с зарегистрированным worker", async () => {
    await withProcessFixture(async (fixture) => {
      const project = fixture.context("lease");
      if (!project.location || !project.options.home) {
        throw new Error("expected fixture context");
      }
      expect(
        (await fixture.request(project.options, "connect", { remote: fixture.remote })).ok,
      ).toBe(true);
      const directory = stateDirectory(project.location.databasePath);
      const config = readConfiguration(directory);
      if (!config) {
        throw new Error("missing connection");
      }
      updateConfiguration(directory, () => ({ ...config, desired: "running", mode: "auto" }));
      const script = join(fixture.root, "foreground-proxy.ts");
      writeFileSync(
        script,
        `import {spawn} from 'node:child_process'; const child=spawn(${JSON.stringify(fixture.binary)},['supervise','--home',${JSON.stringify(project.options.home)},'--parent-lease'],{stdio:['pipe','ignore','ignore'],detached:true}); child.stdin.on('error',()=>{}); setInterval(()=>{},1000);\n`,
      );
      const proxy = Bun.spawn([process.execPath, script], {
        cwd: fixture.root,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      const supervisorPath = join(project.options.home, "git-sync", "supervisor.json");
      const workerPath = join(directory, "worker.json");
      try {
        await eventually(async () => {
          const supervisor = readEndpoint(supervisorPath);
          const worker = readEndpoint(workerPath);
          return (
            supervisor !== null &&
            worker !== null &&
            (await responsive(supervisor)) &&
            (await responsive(worker))
          );
        });

        proxy.kill("SIGKILL");
        await proxy.exited;
        await eventually(
          () => readEndpoint(supervisorPath) === null && readEndpoint(workerPath) === null,
        );

        expect(readConfiguration(directory)?.desired).toBe("running");
        expect(readEndpoint(workerPath)).toBeNull();
        expect(readEndpoint(supervisorPath)).toBeNull();
      } finally {
        proxy.kill("SIGKILL");
        await proxy.exited;
      }
    });
  }, 30_000);
});
