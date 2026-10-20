import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { version } from "../../package.json";

const binary = resolve(import.meta.dir, "../../dist/relay");
const artifacts = resolve(
  import.meta.dir,
  "../../../../.artifacts",
  new Date().toISOString().slice(0, 10),
);

async function invokeBinary(argv: string[], closeStdout = false) {
  await mkdir(artifacts, { recursive: true });
  const directory = await mkdtemp(join(artifacts, "cli-process-"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const process = Bun.spawn([binary, ...argv], {
      cwd: directory,
      env: { HOME: directory, RELAY_HOME: directory },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 3000,
    });
    child = process;
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      closeStdout ? process.stdout.cancel().then(() => "") : new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    return { exitCode, stdout, stderr, files: await readdir(directory) };
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await child.exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

test("бинарник возвращает встроенную версию из пустого каталога без создания файлов", async () => {
  expect(await invokeBinary(["--version"])).toEqual({
    exitCode: 0,
    stdout: `${version}\n`,
    stderr: "",
    files: [],
  });
});

test("бинарник направляет ошибку ввода в stderr и завершает процесс с кодом 2", async () => {
  const result = await invokeBinary(["--unknown"]);
  expect(result.exitCode).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("Неизвестный параметр: --unknown");
  expect(result.files).toEqual([]);
});

test.each([
  { command: ["document", "create"] },
  { command: ["task", "criterion", "add"] },
  { command: ["workspace", "project", "add"] },
  { command: ["plan", "stage", "create"] },
  { command: ["session", "start"] },
])(
  "вложенная справка $command доступна без проекта и обязательных аргументов",
  async ({ command }) => {
    const result = await invokeBinary([...command, "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("ИСПОЛЬЗОВАНИЕ:");
    expect(result.files).toEqual([]);
  },
);

test("неизвестное вложенное действие не открывает и не создаёт проект", async () => {
  const result = await invokeBinary(["document", "missing"]);
  expect(result.exitCode).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).not.toBe("");
  expect(result.files).toEqual([]);
});

test("закрытый получателем stdout завершает бинарник без необработанной ошибки pipe", async () => {
  const result = await invokeBinary(["--help"], true);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.files).toEqual([]);
});
