import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repository } from "./catalog";
import type { CheckEntryCase, CheckEntryProbe } from "./verification.test.types";

const cases: readonly CheckEntryCase[] = [
  {
    name: "несовместимый Node останавливает check до Git и install",
    preflightFailure: "node",
    installExit: 0,
    turboExit: 0,
    expectedExit: 1,
    expectedSteps: ["node"],
  },
  {
    name: "отсутствующий Git останавливает check до install",
    preflightFailure: "git",
    installExit: 0,
    turboExit: 0,
    expectedExit: 1,
    expectedSteps: ["node", "git"],
  },
  {
    name: "отказ frozen install возвращает его код без запуска Turbo",
    preflightFailure: null,
    installExit: 23,
    turboExit: 0,
    expectedExit: 23,
    expectedSteps: ["node", "git", "install"],
  },
  {
    name: "отказ единственного Turbo-запуска сохраняет ненулевой код check",
    preflightFailure: null,
    installExit: 0,
    turboExit: 29,
    expectedExit: 29,
    expectedSteps: ["node", "git", "install", "turbo"],
  },
  {
    name: "успешные preflight и install разрешают один полный Turbo-запуск",
    preflightFailure: null,
    installExit: 0,
    turboExit: 0,
    expectedExit: 0,
    expectedSteps: ["node", "git", "install", "turbo"],
  },
];

/**
 * Исполняет настоящий check.ts в отдельном Bun, подменяя только границу внешних инструментов.
 * Install и полный граф Relay не запускаются. Подмены не попадают в test runner;
 * дочерний процесс ограничен deadline, временный driver удаляется при любом исходе.
 */
async function invokeCheckEntry(input: CheckEntryCase): Promise<CheckEntryProbe> {
  const parent = join(repository, ".artifacts", new Date().toISOString().slice(0, 10), "ci-check");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "check-entry-"));
  try {
    const script = join(root, "probe.mjs");
    const entry = join(repository, "scripts/check.ts");
    const node = (await Bun.file(join(repository, ".node-version")).text()).trim();
    await writeFile(
      script,
      `const input = ${JSON.stringify(input)};
const steps = [];
const commands = [];
/**
 * Задаёт только ответы проверки Node/Git; чтение pins остаётся настоящим.
 */
Bun.spawnSync = (argv) => {
  const step = argv[0];
  steps.push(step);
  let stdout = "git version fixture";
  if (step === "node") {
    stdout = input.preflightFailure === "node" ? "v0.0.0" : ${JSON.stringify(`v${node}`)};
  }
  return {
    exitCode: step === "git" && input.preflightFailure === "git" ? 1 : 0,
    stdout: Buffer.from(stdout),
    stderr: Buffer.alloc(0),
  };
};
/**
 * Запоминает реальный argv/cwd/потоки, но не устанавливает зависимости и не строит продукт.
 */
Bun.spawn = (argv, options) => {
  const step = argv[1] === "install" ? "install" : "turbo";
  steps.push(step);
  commands.push({ argv, cwd: options.cwd, stdin: options.stdin, stdout: options.stdout, stderr: options.stderr });
  return { exited: Promise.resolve(step === "install" ? input.installExit : input.turboExit) };
};
process.argv = [process.execPath, ${JSON.stringify(entry)}, "--concurrency=2"];
await import(${JSON.stringify(pathToFileURL(entry).href)});
console.log("CHECK_PROBE=" + JSON.stringify({ steps, commands }));
`,
    );
    const child = Bun.spawn([process.execPath, script], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5_000,
    });
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      const line = stdout.split("\n").find((entry) => entry.startsWith("CHECK_PROBE="));
      if (line === undefined) {
        throw new Error(
          `Check не завершил трассу инструментов: ${JSON.stringify({ code, stdout, stderr })}`,
        );
      }
      return { code, stderr, trace: JSON.parse(line.slice("CHECK_PROBE=".length)) };
    } finally {
      if (child.exitCode === null) {
        child.kill();
        await child.exited;
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("Порядок фаз и исход процессного входа check", () => {
  test.each(cases)("$name", async (input) => {
    const result = await invokeCheckEntry(input);

    expect(result.code).toBe(input.expectedExit);
    const streams = { cwd: repository, stdin: "inherit", stdout: "inherit", stderr: "inherit" };
    const commands = [];
    if (input.expectedSteps.includes("install")) {
      commands.push({ ...streams, argv: [process.execPath, "install", "--frozen-lockfile"] });
    }
    if (input.expectedSteps.includes("turbo")) {
      commands.push({
        ...streams,
        argv: expect.arrayContaining([
          process.execPath,
          "x",
          "--no-install",
          "turbo",
          "run",
          "--concurrency=2",
          "--continue=dependencies-successful",
        ]),
      });
    }
    expect(result.trace).toEqual({ steps: input.expectedSteps, commands });
    if (input.preflightFailure === "node") {
      expect(result.stderr).toContain("Требуется Node.js");
    } else if (input.preflightFailure === "git") {
      expect(result.stderr).toContain("требуется Git в PATH");
    } else {
      expect(result.stderr).toBe("");
    }
  });
});
