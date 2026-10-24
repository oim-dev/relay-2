import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { EntityRecord } from "@relay/contracts";
import { initializeProject, type ProjectLocation } from "@relay/project-runtime";
import { ProjectDatabase } from "@relay/storage";
import { runCli } from "../../../src/app/run";
import type { CliRuntime } from "../../../src/execution/runtime.types";
import { entityValue, errorValue, pageValue, successValue } from "./responses";
import type { CliInvocation } from "./cli-fixture.types";
import type { ErrorResponse, PageResponse, SuccessResponse } from "./responses.types";

/**
 * Изолированное файловое окружение теста CLI без общей БД и глобального окружения.
 * Владелец вызывает close после завершения всех команд и закрытия соединений.
 */
class CliFixture {
  /* Уникальный каталог проекта и RELAY_HOME, удаляемый при закрытии fixture. */
  readonly root: string;

  /* Явные cwd, env и stdin, передаваемые каждому вызову CLI. */
  readonly runtime: CliRuntime;

  /* Локальный RELAY_HOME; не зависит от окружения процесса тестового runner. */
  private readonly home: string;

  /**
   * Создаёт пустые изолированные каталоги; при отказе подготовки удаляет их самостоятельно.
   * artifactGroup выбирает подкаталог внутри дневных артефактов, не меняя окружение процесса.
   */
  constructor(artifactGroup?: string) {
    const artifacts = resolve(
      import.meta.dir,
      "../../../../../.artifacts",
      new Date().toISOString().slice(0, 10),
      ...(artifactGroup ? [artifactGroup] : []),
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
    this.home = join(this.root, "home");
    this.runtime = {
      cwd,
      env: { RELAY_HOME: this.home, RELAY_ACTOR: "agent" },
      stdin: "",
    };
  }

  /**
   * Создаёт минимальный проект через Runtime, отделяя подготовку от проверяемой CLI-команды.
   * Каталог и база принадлежат fixture и удаляются при close.
   */
  createProject(cwd = this.runtime.cwd): ProjectLocation {
    mkdirSync(cwd, { recursive: true });
    return initializeProject({
      cwd,
      home: this.home,
      name: "Проверка CLI",
      slug: "cli-test",
    });
  }

  /**
   * Передаёт async-подготовке отдельное соединение и закрывает его только после settlement Promise.
   * Callback обязан await каждый writer; внешней SQLite-транзакции у fixture нет.
   */
  withDatabase<T>(
    project: ProjectLocation,
    operation: (db: ProjectDatabase) => Promise<T>,
  ): Promise<T>;
  /**
   * Синхронное чтение/подготовка сохраняет прежний немедленный результат и синхронное закрытие.
   */
  withDatabase<T>(
    project: ProjectLocation,
    operation: (db: ProjectDatabase) => T & (T extends PromiseLike<unknown> ? never : unknown),
  ): T;
  /**
   * Владеет ресурсом независимо от синхронного или асинхронного исхода callback.
   */
  withDatabase<T>(
    project: ProjectLocation,
    operation: (db: ProjectDatabase) => T | Promise<T>,
  ): T | Promise<T> {
    const db = ProjectDatabase.open(project.databasePath);
    let value: T | Promise<T>;
    try {
      value = operation(db);
    } catch (error) {
      db.close();
      throw error;
    }
    if (value instanceof Promise) {
      return value.finally(() => db.close());
    }
    db.close();
    return value;
  }

  /**
   * Вызывает CLI в изолированном контексте и полностью захватывает оба потока без проверок.
   */
  async invoke(
    argv: readonly string[],
    overrides: Partial<CliRuntime> = {},
  ): Promise<CliInvocation> {
    let stdout = "";
    let stderr = "";
    const code = await runCli(
      argv,
      {
        /**
         * Накапливает полный stdout только текущего вызова.
         */
        stdout: (text): void => {
          stdout += text;
        },
        /**
         * Накапливает полный stderr только текущего вызова.
         */
        stderr: (text): void => {
          stderr += text;
        },
      },
      { ...this.runtime, ...overrides },
    );
    return { code, stdout, stderr };
  }

  /**
   * Запрашивает JSON, проверяет нулевой код и пустой stderr, затем декодирует конверт.
   */
  async success(
    argv: readonly string[],
    overrides: Partial<CliRuntime> = {},
  ): Promise<SuccessResponse> {
    const answer = await this.invoke([...argv, "--format=json"], overrides);
    expect(answer, `Команда: ${argv.join(" ")}`).toMatchObject({ code: 0, stderr: "" });
    return successValue(JSON.parse(answer.stdout));
  }

  /**
   * Проверяет успешный вызов и обязательные поля возвращённой записи сущности.
   */
  async entity(
    argv: readonly string[],
    overrides: Partial<CliRuntime> = {},
  ): Promise<EntityRecord> {
    return entityValue((await this.success(argv, overrides)).data);
  }

  /**
   * Проверяет успешный вызов, метаданные снимка и каждый элемент страницы через item.
   */
  async page<T>(
    argv: readonly string[],
    item: (value: unknown) => T,
    overrides: Partial<CliRuntime> = {},
  ): Promise<PageResponse<T>> {
    return pageValue(await this.success(argv, overrides), item);
  }

  /**
   * Проверяет ожидаемый код завершения, пустой stdout и JSON-ошибку в stderr.
   * Предметный код и сохранность данных проверяет сам тест.
   */
  async error(
    argv: readonly string[],
    exitCode: number,
    overrides: Partial<CliRuntime> = {},
  ): Promise<ErrorResponse> {
    const answer = await this.invoke([...argv, "--format=json"], overrides);
    expect(answer, `Команда: ${argv.join(" ")}`).toMatchObject({ code: exitCode, stdout: "" });
    return errorValue(JSON.parse(answer.stderr));
  }

  /**
   * Удаляет каталоги fixture; все использующие их команды и соединения уже должны завершиться.
   */
  close(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

/**
 * Выделяет окружение одному тесту и удаляет его в finally, включая отказ проверок.
 * Callback обязан дождаться своих CLI-вызовов и закрыть самостоятельно открытые ресурсы.
 * artifactGroup позволяет собрать fixtures согласованной проверки под одним дневным каталогом.
 */
export async function withCliFixture<T>(
  run: (cli: CliFixture) => Promise<T>,
  artifactGroup?: string,
): Promise<T> {
  const cli = new CliFixture(artifactGroup);
  try {
    return await run(cli);
  } finally {
    cli.close();
  }
}
