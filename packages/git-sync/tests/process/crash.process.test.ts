import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openProject } from "@relay/project-runtime";
import { withProcessFixture, eventually, startSyncRequest } from "./process-fixture";
import { readEndpoint } from "../../src/local/control";
import { stateDirectory } from "../../src/local/state";
import { requestObject } from "../../src/app/protocol";
import { running } from "./native/process-observation";

describe("Crash ownership одноразового Git/SSH", () => {
  test.skipIf(process.platform === "win32")(
    "SIGKILL CLI закрывает lease Git-потомков, сохраняет pending и допускает новый one-shot",
    async () => {
      await withProcessFixture(async (fixture) => {
        const project = fixture.context("crash");
        if (!project.location) {
          throw new Error("Ожидалась база проекта fixture");
        }
        expect(
          (await fixture.request(project.options, "connect", { remote: fixture.remote })).ok,
        ).toBe(true);
        const database = openProject(project.options).database;
        let pending: number;
        try {
          pending = database.getReplicationStatus().pending;
        } finally {
          database.close();
        }
        const shim = join(fixture.root, "shim");
        mkdirSync(shim);
        const barrier = join(fixture.root, "git-entered.json");
        const realGit = Bun.which("git");
        const bun = Bun.which("bun");
        if (!realGit || !bun) {
          throw new Error("Для process fixture нужны Git и Bun");
        }
        writeFileSync(
          join(shim, "git"),
          `#!${bun}\nimport {spawn} from 'node:child_process';\nimport {renameSync,writeFileSync} from 'node:fs';\nconst args=process.argv.slice(2);\nif(args.includes('ls-remote')){ const child=spawn(${JSON.stringify(bun)},['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}); const ready=${JSON.stringify(barrier)}; writeFileSync(ready+'.tmp',JSON.stringify({pid:process.pid,child:child.pid})); renameSync(ready+'.tmp',ready); setInterval(()=>{},1000); } else { const git=spawn(${JSON.stringify(realGit)},args,{stdio:'inherit'}); git.on('exit',code=>{process.exitCode=code??1;}); }\n`,
          { mode: 0o700 },
        );
        const id = "crashed-now";
        const request = startSyncRequest(
          fixture.binary,
          project.options,
          "now",
          { operationId: id, waitMs: 10_000 },
          { PATH: `${shim}:${process.env.PATH ?? ""}` },
        );
        let actors: readonly number[] = [];
        try {
          await eventually(() => existsSync(barrier));
          const pids = requestObject(JSON.parse(readFileSync(barrier, "utf8")));
          if (typeof pids.pid !== "number" || typeof pids.child !== "number") {
            throw new Error("Повреждён PID-барьер Git-потомков");
          }
          actors = [pids.pid, pids.child];
          const endpoint = readEndpoint(
            join(stateDirectory(project.location.databasePath), "worker.json"),
          );
          expect(endpoint).toMatchObject({ kind: "request", pid: request.child.pid });
          expect(actors.map(running)).toEqual([true, true]);

          request.child.kill("SIGKILL");
          const killed = await request.outcome;
          await eventually(() => actors.every((pid) => !running(pid)), 5000);

          expect(killed.exitCode).toBe(137);
          expect(actors.map(running)).toEqual([false, false]);
          const preserved = openProject(project.options).database;
          try {
            expect(preserved.getReplicationStatus().pending).toBe(pending);
          } finally {
            preserved.close();
          }
          expect(
            await fixture.request(project.options, "request.get", { requestId: id }),
          ).toMatchObject({ ok: true, data: { requestId: id, state: "unknown" } });
          expect(
            await fixture.request(project.options, "now", { operationId: "after-crash" }),
          ).toMatchObject({
            ok: true,
            data: { requestId: "after-crash", pending: { changesets: 0 } },
          });
        } finally {
          if (request.child.exitCode === null) {
            request.child.kill("SIGKILL");
          }
          await request.outcome.catch(() => {});
          for (const pid of actors) {
            if (running(pid)) {
              process.kill(pid, "SIGKILL");
            }
          }
        }
      });
    },
    20_000,
  );
});
