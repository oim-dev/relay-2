import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runNativeProcess } from "@relay/project-runtime";
import { withRuntimeDirectory } from "./helpers/source-runtime-fixture";

const entry = fileURLToPath(new URL("./helpers/process-scope-actor.ts", import.meta.url));

describe("Одинаковый lifetime source и standalone scope", () => {
  test.each(["plain", "observed"])(
    "pending и closed не зависят от режима observer: %s",
    async (mode) => {
      await withRuntimeDirectory(async (root) => {
        const binary = join(root, process.platform === "win32" ? "scope-probe.exe" : "scope-probe");
        const built = await Bun.build({
          entrypoints: [entry],
          target: "bun",
          format: "esm",
          bytecode: true,
          compile: {
            outfile: binary,
            autoloadDotenv: false,
            autoloadBunfig: false,
            autoloadPackageJson: false,
            autoloadTsconfig: false,
          },
        });
        expect(built.success).toBe(true);
        for (const standalone of [false, true]) {
          const directory = join(root, standalone ? "standalone" : "source");
          mkdirSync(directory);
          const result = await runNativeProcess({
            executable: standalone ? binary : process.execPath,
            args: [...(standalone ? [] : [entry]), "--inspect", directory, mode],
            cwd: directory,
            env: { ...process.env, HOME: directory, RELAY_HOME: join(directory, "relay-home") },
            timeoutMs: 8000,
          });
          expect(result.exitCode).toBe(0);
          expect(result.stderr).toBe("");
          const report: unknown = JSON.parse(result.stdout);
          expect(report).toEqual({
            standalone,
            observed: mode === "observed",
            targetWasLive: true,
            returnedWhileTargetLive: false,
            code: 0,
            stdout: "target-done",
            lateResult: "GIT_CANCELLED",
            lateMarker: false,
            helperRemoved: true,
          });
        }
      });
    },
    15_000,
  );
});
