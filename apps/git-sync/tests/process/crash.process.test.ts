import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withProcessFixture, eventually } from "./process-fixture";
import { readEndpoint } from "../../src/local/control";
import { stateDirectory } from "../../src/local/state";
import { requestObject } from "../../src/app/protocol";
import { startTestSupervisor } from "./supervisor-fixture";
import { running } from "./native/process-observation";

describe("Crash ownership Git/SSH", () => {
  test.skipIf(process.platform === "win32")(
    "SIGKILL worker закрывает lease и helper завершает задержанный Git вместе с потомком",
    async () => {
      await withProcessFixture(async (fixture) => {
        const project = fixture.context("crash");
        if (!project.location) {
          throw new Error("expected initialized fixture");
        }
        expect(
          (await fixture.request(project.options, "connect", { remote: fixture.remote })).ok,
        ).toBe(true);
        const shim = join(fixture.root, "shim");
        mkdirSync(shim);
        const barrier = join(fixture.root, "git-entered.json");
        const realGit = Bun.which("git");
        const bun = Bun.which("bun");
        if (!realGit || !bun) {
          throw new Error("Git/Bun unavailable");
        }
        writeFileSync(
          join(shim, "git"),
          `#!${bun}\nimport {spawn} from 'node:child_process';\nimport {writeFileSync} from 'node:fs';\nconst args=process.argv.slice(2);\nif(args.includes('ls-remote')){ const child=spawn(${JSON.stringify(bun)},['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}); writeFileSync(${JSON.stringify(barrier)},JSON.stringify({pid:process.pid,child:child.pid})); setInterval(()=>{},1000); } else { const git=spawn(${JSON.stringify(realGit)},args,{stdio:'inherit'}); git.on('exit',code=>{process.exitCode=code??1;}); }\n`,
          { mode: 0o700 },
        );
        const supervisor = await startTestSupervisor(fixture.binary, project.options, {
          PATH: `${shim}:${process.env.PATH ?? ""}`,
        });
        try {
          const endpointPath = join(stateDirectory(project.location.databasePath), "worker.json");
          const started = await fixture.request(
            project.options,
            "auto.enable",
            {},
            { PATH: `${shim}:${process.env.PATH ?? ""}` },
          );
          expect(started.ok).toBe(true);
          await eventually(() => existsSync(barrier));
          const pids = requestObject(JSON.parse(readFileSync(barrier, "utf8")));
          if (typeof pids.pid !== "number" || typeof pids.child !== "number") {
            throw new Error("bad barrier");
          }
          const gitPid = pids.pid;
          const childPid = pids.child;
          const endpoint = readEndpoint(endpointPath);
          if (!endpoint) {
            throw new Error("missing readiness");
          }
          try {
            expect(running(gitPid)).toBe(true);
            expect(running(childPid)).toBe(true);

            process.kill(endpoint.pid, "SIGKILL");
            await eventually(() => !running(gitPid) && !running(childPid), 5000);

            expect(running(gitPid)).toBe(false);
            expect(running(childPid)).toBe(false);
            const restarted = await fixture.request(project.options, "worker.start");
            expect(restarted.ok).toBe(true);
            expect(readEndpoint(endpointPath)?.instance).not.toBe(endpoint.instance);
          } finally {
            for (const pid of [gitPid, childPid]) {
              if (running(pid)) {
                process.kill(pid, "SIGKILL");
              }
            }
          }
        } finally {
          await supervisor.stop();
        }
      });
    },
    20_000,
  );
});
