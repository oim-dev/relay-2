import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { componentTasks, repository, repositoryTasks } from "./catalog";
import { checkCommand } from "./check-command";

describe("Исполнение зависимостей полного check", () => {
  test("отказ единственного producer блокирует оба чтения старого dist, но не независимую проверку", async () => {
    const parent = join(
      repository,
      ".artifacts",
      new Date().toISOString().slice(0, 10),
      "ci-check",
    );
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "failed-producer-"));
    try {
      const workspace = join(root, "packages/subject");
      await mkdir(join(workspace, "dist"), { recursive: true });
      await writeFile(join(workspace, "dist/state.txt"), "Старая сборка");
      await Bun.write(
        join(root, "package.json"),
        JSON.stringify({
          name: "verification-fixture",
          private: true,
          packageManager: `bun@${Bun.version}`,
          workspaces: ["packages/*"],
          scripts: { "test:unit:repo": "bun operation.ts independent" },
        }),
      );
      await Bun.write(
        join(workspace, "package.json"),
        JSON.stringify({
          name: "@verification/subject",
          scripts: {
            build: "bun ../../operation.ts build",
            "test:process": "bun ../../operation.ts process",
            "test:e2e": "bun ../../operation.ts e2e",
          },
        }),
      );
      await Bun.write(
        join(root, "bun.lock"),
        JSON.stringify({
          lockfileVersion: 1,
          configVersion: 1,
          workspaces: {
            "": { name: "verification-fixture" },
            "packages/subject": { name: "@verification/subject" },
          },
          packages: {},
        }),
      );
      await Bun.write(
        join(root, "turbo.json"),
        JSON.stringify({
          remoteCache: { enabled: false },
          tasks: {
            ...Object.fromEntries(
              [...componentTasks, ...repositoryTasks.map((task) => `//#${task}`)].map((task) => [
                task,
                { cache: false },
              ]),
            ),
            "test:process": { dependsOn: ["build"], cache: false },
            "test:e2e": { dependsOn: ["build"], cache: false },
          },
        }),
      );
      // Настоящий Turbo выполняет только маленькие marker-команды, не сборки Relay.
      await writeFile(
        join(root, "operation.ts"),
        `import { appendFile } from "node:fs/promises";
import { join } from "node:path";
const action = process.argv[2];
await appendFile(join(import.meta.dir, action + ".ran"), action + "\\n");
if (action === "build") {
  process.exitCode = 23;
}
`,
      );

      const child = Bun.spawn([...checkCommand(2), `--cwd=${root}`], {
        cwd: repository,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15_000,
      });
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);

        expect(code, JSON.stringify({ stdout, stderr })).not.toBe(0);
        expect(await readFile(join(root, "build.ran"), "utf8")).toBe("build\n");
        expect(await readFile(join(root, "independent.ran"), "utf8")).toBe("independent\n");
        expect(existsSync(join(root, "process.ran"))).toBe(false);
        expect(existsSync(join(root, "e2e.ran"))).toBe(false);
        expect(await readFile(join(workspace, "dist/state.txt"), "utf8")).toBe("Старая сборка");
      } finally {
        if (child.exitCode === null) {
          child.kill();
          await child.exited;
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});
