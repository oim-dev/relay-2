import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  initializeProject,
  nativeExecutableName,
  runNativeProcess,
  type ProcessResult,
  type ProjectLocation,
} from "@relay/project-runtime";
import { ProjectDatabase } from "@relay/storage";
import type { GitSyncProcessFixture } from "./git-sync-process.types";

const binary =
  process.env.RELAY_CLI_TEST_BINARY ??
  resolve(import.meta.dir, "../../dist", nativeExecutableName("relay"));

/**
 * Копирует только собранный relay, создаёт независимые HOME/SQLite/bare Git и удаляет их в finally.
 * Отдельный компонент не собирается и не подставляется: CLI должен содержать Git Sync самостоятельно.
 * PATH содержит только каталог настоящего Git; пользовательские Git config и Relay env не наследуются.
 * Каждый child ограничен deadline, его потоки и завершение принадлежат Runtime process runner.
 */
export async function withGitSyncCli(
  operation: (fixture: GitSyncProcessFixture) => Promise<void>,
): Promise<void> {
  const artifacts = resolve(
    import.meta.dir,
    "../../../../.artifacts",
    new Date().toISOString().slice(0, 10),
    "project-local-sync/package-tests-review/fixtures",
  );
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "cli-git-"));
  try {
    const executable = Bun.which("git");
    if (executable === null) {
      throw new Error("Процессным проверкам настоящего Git Sync нужен установленный Git");
    }
    const tools = join(root, "bin");
    const home = join(root, "home");
    const cwd = join(root, "проект с пробелом");
    mkdirSync(tools);
    mkdirSync(home);
    const relay = join(tools, nativeExecutableName("relay"));
    copyFileSync(binary, relay);
    const config = join(home, "gitconfig");
    writeFileSync(config, "");
    const options = { cwd, home: join(root, "relay-home") };
    const location = initializeProject({
      ...options,
      name: "Процессный обмен",
      slug: "process-sync",
    });
    const env = {
      HOME: home,
      USERPROFILE: home,
      RELAY_HOME: options.home,
      PATH: dirname(executable),
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
      ...(process.env.PATHEXT === undefined ? {} : { PATHEXT: process.env.PATHEXT }),
    };
    /**
     * Исполняет настоящий Git без shell; подготовка не попадает в trace проверяемой CLI.
     */
    const git = async (directory: string, args: readonly string[]): Promise<string> => {
      const result = await runNativeProcess({
        executable,
        args,
        cwd: directory,
        env,
        timeoutMs: 5000,
      });
      if (result.exitCode !== 0) {
        throw new Error(
          `Git ${args.join(" ")} завершился с кодом ${result.exitCode}: ${result.stderr}`,
        );
      }
      return result.stdout.trim();
    };
    const remote = join(root, "origin с пробелом $(literal).git");
    await git(root, ["init", "--bare", "--initial-branch=main", remote]);
    const tracePath = join(root, "cli-git-trace.jsonl");
    await operation({
      root,
      options,
      location,
      remote,
      tracePath,
      git,
      /**
       * Ждёт один настоящий CLI-вызов; никакие argv, requestId или ответы не исправляются fixture.
       */
      invoke: (argv, input, directory = cwd): Promise<ProcessResult> =>
        runNativeProcess({
          executable: relay,
          args: argv,
          cwd: directory,
          env: { ...env, GIT_TRACE2_EVENT: tracePath },
          ...(input === undefined ? {} : { input }),
          timeoutMs: 5000,
        }),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Даёт тесту отдельное реальное соединение и закрывает его после settlement чтения или Core writer.
 */
export async function withSyncDatabase<T>(
  location: ProjectLocation,
  operation: (database: ProjectDatabase) => T | Promise<T>,
): Promise<T> {
  const database = ProjectDatabase.open(location.databasePath);
  try {
    return await operation(database);
  } finally {
    database.close();
  }
}

/**
 * Создаёт только Git-контекст кодового каталога; подключение и обмен ещё не выполнялись.
 */
export async function addProjectOrigin(fixture: GitSyncProcessFixture): Promise<void> {
  await fixture.git(fixture.options.cwd, ["init", "--initial-branch=main", "."]);
  await fixture.git(fixture.options.cwd, ["remote", "add", "origin", fixture.remote]);
}

/**
 * Делает технический debounce созревшим без sleep; данные, outbox и режим обмена сохраняются.
 */
export function makeProjectSyncDue(location: ProjectLocation): void {
  const database = new Database(location.databasePath);
  try {
    database.exec(
      "UPDATE synchronization_schedule SET dirty_since=0,last_mutation_at=0,next_attempt_at=0",
    );
  } finally {
    database.close();
  }
}
