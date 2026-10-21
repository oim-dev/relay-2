import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { initializeProject, type ProjectLocation } from "@relay/project-runtime";
import { ProjectDatabase } from "@relay/storage";
import { runCli, type CliRuntime } from "../../../src/run";
import { entityValue, errorValue, pageValue, successValue } from "./responses";

class CliFixture {
  readonly root: string;
  readonly runtime: CliRuntime;

  constructor() {
    const artifacts = resolve(
      import.meta.dir,
      "../../../../../.artifacts",
      new Date().toISOString().slice(0, 10),
    );
    mkdirSync(artifacts, { recursive: true });
    this.root = mkdtempSync(join(artifacts, "cli-integration-"));
    const cwd = join(this.root, "project");
    try {
      mkdirSync(cwd);
    } catch (error) {
      rmSync(this.root, { recursive: true, force: true });
      throw error;
    }
    this.runtime = {
      cwd,
      env: { RELAY_HOME: join(this.root, "home"), RELAY_ACTOR: "agent" },
      stdin: "",
    };
  }

  /** Подготовка через Runtime/Core отделена от CLI-действия, которое проверяет тест. */
  createProject(cwd = this.runtime.cwd): ProjectLocation {
    mkdirSync(cwd, { recursive: true });
    return initializeProject({
      cwd,
      home: this.runtime.env.RELAY_HOME!,
      name: "Проверка CLI",
      slug: "cli-test",
    });
  }

  withDatabase<T>(
    project: ProjectLocation,
    operation: (db: ProjectDatabase) => T & (T extends PromiseLike<unknown> ? never : unknown),
  ): T {
    const db = ProjectDatabase.open(project.databasePath);
    try {
      return operation(db);
    } finally {
      db.close();
    }
  }

  async invoke(argv: string[], overrides: Partial<CliRuntime> = {}) {
    let stdout = "";
    let stderr = "";
    const code = await runCli(
      argv,
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      },
      { ...this.runtime, ...overrides },
    );
    return { code, stdout, stderr };
  }

  async success(argv: string[], overrides: Partial<CliRuntime> = {}) {
    const answer = await this.invoke([...argv, "--format=json"], overrides);
    expect(answer, `Команда: ${argv.join(" ")}`).toMatchObject({ code: 0, stderr: "" });
    return successValue(JSON.parse(answer.stdout));
  }

  async entity(argv: string[], overrides: Partial<CliRuntime> = {}) {
    return entityValue((await this.success(argv, overrides)).data);
  }

  async page<T>(argv: string[], item: (value: unknown) => T, overrides: Partial<CliRuntime> = {}) {
    return pageValue(await this.success(argv, overrides), item);
  }

  async error(argv: string[], exitCode: number, overrides: Partial<CliRuntime> = {}) {
    const answer = await this.invoke([...argv, "--format=json"], overrides);
    expect(answer, `Команда: ${argv.join(" ")}`).toMatchObject({ code: exitCode, stdout: "" });
    return errorValue(JSON.parse(answer.stderr));
  }

  close(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

/** Каждому тесту принадлежит собственное окружение; общих hooks и изменяемых переменных нет. */
export async function withCliFixture<T>(run: (cli: CliFixture) => Promise<T>): Promise<T> {
  const cli = new CliFixture();
  try {
    return await run(cli);
  } finally {
    cli.close();
  }
}
