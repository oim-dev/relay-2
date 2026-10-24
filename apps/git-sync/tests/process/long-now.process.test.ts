import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withProcessFixture, eventually } from "./process-fixture";
import { startTestSupervisor } from "./supervisor-fixture";
import { requestObject } from "../../src/app/protocol";

describe("Принятый долгий now", () => {
  test.skipIf(process.platform === "win32")(
    "после deadline owner остаётся ready, request.get возвращает настоящий terminal result",
    async () => {
      await withProcessFixture(async (fixture) => {
        const project = fixture.context("long-now");
        expect(
          (await fixture.request(project.options, "connect", { remote: fixture.remote })).ok,
        ).toBe(true);
        const shim = join(fixture.root, "long-git");
        mkdirSync(shim);
        const hold = join(fixture.root, "hold-fetch");
        const entered = join(fixture.root, "entered-fetch");
        writeFileSync(hold, "hold");
        const git = Bun.which("git");
        const bun = Bun.which("bun");
        if (!git || !bun) {
          throw new Error("Git/Bun required");
        }
        writeFileSync(
          join(shim, "git"),
          `#!${bun}\nimport {spawn} from 'node:child_process'; import {existsSync,writeFileSync} from 'node:fs'; const args=process.argv.slice(2); if(args.includes('ls-remote')){writeFileSync(${JSON.stringify(entered)},'entered'); while(existsSync(${JSON.stringify(hold)})){await Bun.sleep(20);}} const child=spawn(${JSON.stringify(git)},args,{stdio:'inherit'}); child.on('exit',code=>{process.exitCode=code??1});\n`,
          { mode: 0o700 },
        );
        const supervisor = await startTestSupervisor(fixture.binary, project.options, {
          PATH: `${shim}:${process.env.PATH ?? ""}`,
        });
        try {
          expect((await fixture.request(project.options, "worker.start")).ok).toBe(true);
          const id = crypto.randomUUID();
          const waiting = fixture.request(project.options, "now", { operationId: id, waitMs: 100 });
          await eventually(() => existsSync(entered));
          const deadline = await waiting;
          expect(deadline).toMatchObject({
            ok: false,
            error: { code: "GIT_SYNC_WAIT_TIMEOUT", details: { requestId: id, state: "running" } },
          });
          expect(
            await fixture.request(project.options, "request.get", { requestId: id }),
          ).toMatchObject({ ok: true, data: { requestId: id, state: "running" } });
          expect(await fixture.request(project.options, "status")).toMatchObject({
            ok: true,
            data: { worker: { responsive: true } },
          });

          rmSync(hold);
          await eventually(async () => {
            const result = await fixture.request(project.options, "request.get", { requestId: id });
            return result.ok && requestObject(result.data).state === "completed";
          });
          expect(await fixture.request(project.options, "now", { requestId: id })).toMatchObject({
            ok: true,
            data: { requestId: id, pending: { changesets: 0 } },
          });
        } finally {
          rmSync(hold, { force: true });
          await supervisor.stop();
        }
      });
    },
    30_000,
  );
});
