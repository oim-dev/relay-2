import { expect, spyOn, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { withTeamFixture } from "./team-helpers/team-fixture";
import * as commands from "../../src/transport/git";

test("отказ finite fixture сохраняет отдельно реальные Git durations и bounded phase markers", async () => {
  const failure = new Error("Намеренный отказ для проверки диагностического артефакта");
  let reportPath: string | undefined;
  const invocation = spyOn(commands, "git");
  try {
    await expect(
      withTeamFixture(
        async (team) => {
          const replica = await team.replica();
          await replica.engine.run();
          expect(replica.replication.status().pending).toBe(0);
          throw failure;
        },
        (path) => {
          reportPath = path;
        },
      ),
    ).rejects.toBe(failure);

    if (reportPath === undefined) {
      throw new Error("Отчёт отказа не опубликован");
    }
    const report: unknown = JSON.parse(readFileSync(reportPath, "utf8"));
    expect(report).toMatchObject({
      version: 1,
      replicas: 1,
      helperBuildMs: expect.any(Number),
      failure: { message: failure.message },
      gitWrapper: {
        "setup/init": { count: 2 },
        "committing/fast-import": { count: 1 },
      },
      phaseCosts: {
        fetching: { count: 1 },
        committing: { count: 1 },
      },
      gitNative: {
        starts: invocation.mock.calls.length,
        exits: invocation.mock.calls.length,
        truncated: false,
        invalidLines: 0,
      },
    });
  } finally {
    invocation.mockRestore();
    if (reportPath !== undefined) {
      rmSync(reportPath, { force: true });
    }
  }
}, 15_000);
