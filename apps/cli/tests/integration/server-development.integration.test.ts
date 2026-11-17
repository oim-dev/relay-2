import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  createServerClient,
  createServerLaunch,
  nativeExecutableName,
} from "@relay/project-runtime";
import { version } from "../../package.json";
import { withCliFixture } from "./helpers/cli-fixture";
import { spawnServerTestProcess } from "./helpers/server-process";

const managedActions = [{ name: "stop" }, { name: "restart" }] as const;

/**
 * Подменяет только desktop launcher маленьким автономным recorder, не запускающим браузер.
 * URL выбирает настоящий Runtime open. Собственная сборка работает и без shell в Windows;
 * executable и запись аргументов принадлежат каталогу CLI fixture.
 */
async function createBrowserRecorder(directory: string): Promise<string> {
  const bin = join(directory, "browser-bin");
  mkdirSync(bin);
  const source = join(bin, "recorder.ts");
  writeFileSync(
    source,
    `await Bun.write(process.env.RELAY_TEST_BROWSER_CAPTURE, JSON.stringify(process.argv.slice(2)));\n`,
  );
  const result = await Bun.build({
    entrypoints: [source],
    target: "bun",
    compile: {
      outfile: join(bin, nativeExecutableName("xdg-open")),
      autoloadDotenv: false,
      autoloadBunfig: false,
      autoloadPackageJson: false,
      autoloadTsconfig: false,
    },
  });
  if (!result.success) {
    throw new AggregateError(result.logs, "Не удалось собрать recorder браузерного launcher");
  }
  return bin;
}

describe("Наблюдение dev-сервера через CLI", () => {
  test("status JSON и list text разделяют API и Vite, open передаёт браузеру именно Vite", async () => {
    await withCliFixture(async (cli) => {
      cli.createProject();
      const options = { cwd: cli.runtime.cwd, home: String(cli.runtime.env.RELAY_HOME) };
      const webUrl = "http://127.0.0.1:5174";
      const launch = createServerLaunch(options, {
        version,
        mode: "foreground",
        development: { webUrl },
      });
      const bin = await createBrowserRecorder(cli.root);
      const capture = join(cli.root, "browser-arguments.json");
      const client = createServerClient({
        cwd: cli.root,
        env: {
          PATH: bin,
          HOME: cli.root,
          USERPROFILE: cli.root,
          RELAY_TEST_BROWSER_CAPTURE: capture,
        },
        userHome: cli.root,
        executablePath: process.execPath,
        platform: "linux",
        version,
      });
      const owner = await spawnServerTestProcess(launch);
      try {
        const response = await cli.success(["server", "status", "--instance", launch.instanceId], {
          server: client,
        });
        const text = await cli.invoke(["server", "list"], { server: client });
        const opened = await cli.success(["server", "open", "--instance", launch.instanceId], {
          server: client,
        });

        expect(response.data).toMatchObject({
          running: 1,
          registered: 1,
          items: [
            {
              instanceId: launch.instanceId,
              state: "ready",
              mode: "foreground",
              development: { webUrl },
            },
          ],
        });
        expect(text).toMatchObject({ code: 0, stderr: "" });
        expect(text.stdout).toContain("готов [dev]");
        expect(text.stdout).toContain("API: http://127.0.0.1:");
        expect(text.stdout).toContain(`Web: ${webUrl}`);
        expect(text.stdout).toContain("терминал dev-запуска");
        expect(opened.data).toMatchObject({
          instanceId: launch.instanceId,
          state: "ready",
          development: { webUrl },
        });
        expect(JSON.parse(readFileSync(capture, "utf8"))).toEqual([webUrl]);
        expect(owner.child.exitCode).toBeNull();
      } finally {
        await owner.close();
      }
    }, "dev-mode-test-review/fixtures");
  });

  test.each(managedActions)(
    "$name отклоняет dev до binary discovery и чтения endpoint, сохраняя регистрацию",
    async ({ name }) => {
      await withCliFixture(async (cli) => {
        cli.createProject();
        const options = { cwd: cli.runtime.cwd, home: String(cli.runtime.env.RELAY_HOME) };
        const launch = createServerLaunch(options, {
          version,
          mode: "foreground",
          development: { webUrl: "http://127.0.0.1:5174" },
        });
        const client = createServerClient({
          cwd: cli.root,
          env: {},
          userHome: cli.root,
          executablePath: process.execPath,
          binary: join(cli.root, "missing-server-must-not-be-probed"),
          version,
        });
        const saved = readFileSync(launch.path, "utf8");
        const endpointPath = join(dirname(launch.path), "endpoint.json");
        // Неисправный endpoint не должен маскировать отказ dev и не должен читаться до guard.
        const corruptedEndpoint = "Намеренно повреждённый endpoint";
        writeFileSync(endpointPath, corruptedEndpoint);

        const failure = await cli.error(["server", name, "--instance", launch.instanceId], 4, {
          server: client,
        });

        expect(failure).toMatchObject({
          code: "SERVER_DEVELOPMENT_MANAGED",
          details: { instanceId: launch.instanceId },
        });
        expect(failure.message).toContain("bun run dev");
        expect(readFileSync(launch.path, "utf8")).toBe(saved);
        expect(readFileSync(endpointPath, "utf8")).toBe(corruptedEndpoint);
      }, "dev-mode-test-review/fixtures");
    },
  );
});
