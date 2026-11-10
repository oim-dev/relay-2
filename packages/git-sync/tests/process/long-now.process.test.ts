import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withProcessFixture, eventually, startSyncRequest } from "./process-fixture";
import { readEndpoint, responsive } from "../../src/local/control";
import { stateDirectory } from "../../src/local/state";

describe("Наблюдение долгого одноразового now", () => {
  test.skipIf(process.platform === "win32")(
    "deadline отдельного ожидания не отменяет живой one-shot и сохраняет его terminal result",
    async () => {
      await withProcessFixture(async (fixture) => {
        const project = fixture.context("long-now");
        if (project.location === null) {
          throw new Error("Ожидалась база одноразового запроса");
        }
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
          throw new Error("Для Git-барьера нужны Git и Bun");
        }
        writeFileSync(
          join(shim, "git"),
          `#!${bun}\nimport {spawn} from 'node:child_process'; import {existsSync,renameSync,writeFileSync} from 'node:fs'; const args=process.argv.slice(2); if(args.includes('ls-remote')){const ready=${JSON.stringify(entered)};writeFileSync(ready+'.tmp','entered');renameSync(ready+'.tmp',ready); while(existsSync(${JSON.stringify(hold)})){await Bun.sleep(20);}} const child=spawn(${JSON.stringify(git)},args,{stdio:'inherit'}); child.on('exit',code=>{process.exitCode=code??1});\n`,
          { mode: 0o700 },
        );
        const id = crypto.randomUUID();
        const owner = startSyncRequest(
          fixture.binary,
          project.options,
          "now",
          { operationId: id, waitMs: 10_000 },
          { PATH: `${shim}:${process.env.PATH ?? ""}` },
        );
        const endpointPath = join(stateDirectory(project.location.databasePath), "worker.json");
        try {
          await eventually(() => existsSync(entered));

          const deadline = await fixture.request(project.options, "now", {
            requestId: id,
            waitMs: 40,
          });

          expect(deadline).toMatchObject({
            ok: false,
            error: { code: "GIT_SYNC_WAIT_TIMEOUT", details: { requestId: id, state: "running" } },
          });
          expect(
            await fixture.request(project.options, "request.get", { requestId: id }),
          ).toMatchObject({ ok: true, data: { requestId: id, state: "running" } });
          const endpoint = readEndpoint(endpointPath);
          if (endpoint === null) {
            throw new Error("Одноразовый owner исчез до release барьера");
          }
          expect(endpoint).toMatchObject({ kind: "request", pid: owner.child.pid });
          expect(await responsive(endpoint)).toBe(true);

          rmSync(hold);
          const completed = await owner.outcome;

          expect(completed).toMatchObject({ exitCode: 0, stderr: "" });
          expect(JSON.parse(completed.stdout)).toMatchObject({
            version: 1,
            ok: true,
            data: { requestId: id, pending: { changesets: 0 } },
          });
          expect(readEndpoint(endpointPath)).toBeNull();
          expect(
            await fixture.request(project.options, "request.get", { requestId: id }),
          ).toMatchObject({ ok: true, data: { requestId: id, state: "completed" } });
          expect(await fixture.request(project.options, "now", { requestId: id })).toMatchObject({
            ok: true,
            data: { requestId: id, pending: { changesets: 0 } },
          });
        } finally {
          rmSync(hold, { force: true });
          if (owner.child.exitCode === null) {
            owner.child.kill("SIGKILL");
          }
          await owner.outcome.catch(() => {});
        }
      });
    },
    30_000,
  );
});
