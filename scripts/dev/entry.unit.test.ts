import { describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

describe("Композиция отказов процессного dev-входа", () => {
  test("отказ наблюдения вместе с guardian cleanup сохраняет обе ошибки и native cause", async () => {
    const artifacts = resolve(
      import.meta.dir,
      "../../.artifacts",
      new Date().toISOString().slice(0, 10),
      "dev-mode-test-review/entry-errors",
    );
    await mkdir(artifacts, { recursive: true });
    const directory = await mkdtemp(join(artifacts, "entry-"));
    let child: Subprocess<"ignore", "pipe", "pipe"> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "fixtures/entry-error-worker.ts"),
          "--playground",
          join(directory, "not-opened-project"),
        ],
        {
          cwd: directory,
          env: {
            HOME: directory,
            USERPROFILE: directory,
            RELAY_HOME: join(directory, "home"),
            PATH: "",
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      timer = setTimeout(() => child?.kill("SIGKILL"), 5000);

      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);

      expect(exitCode).toBe(1);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toEqual({
        aggregate: true,
        observation: true,
        nativeCause: true,
        cleanup: true,
        forwardedAbort: true,
        disposed: 1,
        errorReports: 1,
      });
    } finally {
      clearTimeout(timer);
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await child?.exited;
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
