import { expect } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ProcessResult, RecordResult, WorkflowEnvironment } from "./workflow-fixture.types";

const binary = resolve(import.meta.dir, "../../../apps/cli/dist/relay");
const artifacts = resolve(
  import.meta.dir,
  "../../../.artifacts",
  new Date().toISOString().slice(0, 10),
);
const processDeadlineMs = 10_000;

/**
 * Создаёт окружение без пользовательского HOME и RELAY_HOME.
 * Каждый вызов invoke запускает новый бинарник, чтобы маршрут проверял сохранённое состояние.
 * Владение каталогом передаётся вызывающему коду: close обязателен в finally.
 */
export async function createWorkflowEnvironment(): Promise<WorkflowEnvironment> {
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(join(artifacts, "local-workflow-"));
  const home = join(root, "home");
  try {
    await mkdir(home);
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }

  return {
    root,
    /**
     * Выполняет команду с изолированным окружением и читает оба потока параллельно.
     * Незавершённый процесс останавливается до возврата управления вызывающему коду.
     */
    async invoke(cwd: string, argv: readonly string[], stdin?: string): Promise<ProcessResult> {
      const child = Bun.spawn([binary, ...argv], {
        cwd,
        env: { HOME: home, RELAY_HOME: join(home, ".relay") },
        stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
        stdout: "pipe",
        stderr: "pipe",
        timeout: processDeadlineMs,
      });
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        return { code, stdout, stderr };
      } finally {
        if (child.exitCode === null) {
          child.kill();
          await child.exited;
        }
      }
    },
    /**
     * Удаляет временные проекты и их базы после окончания маршрута.
     */
    async close(): Promise<void> {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * Распознаёт объект на внешней границе JSON, исключая массивы и null.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Выполняет успешную JSON-команду, проверяя код завершения, stderr и оболочку ответа.
 * Предметное содержание результата остаётся обязанностью сквозного маршрута.
 */
export async function invokeSuccess(
  env: WorkflowEnvironment,
  cwd: string,
  argv: readonly string[],
  stdin?: string,
): Promise<unknown> {
  const result = await env.invoke(cwd, [...argv, "--format", "json"], stdin);
  expect(result, `Неуспешная команда: ${argv.join(" ")}`).toMatchObject({ code: 0, stderr: "" });
  const response: unknown = JSON.parse(result.stdout);
  if (!isObject(response) || response.ok !== true || !Object.hasOwn(response, "data")) {
    throw new Error("Успешная команда должна вернуть JSON с ok: true и data");
  }
  return response.data;
}

/**
 * Возвращает карточку успешной команды после проверки общих полей ответа.
 * Не выводит ожидаемые предметные значения из реализации Core.
 */
export async function invokeRecord(
  env: WorkflowEnvironment,
  cwd: string,
  argv: readonly string[],
  stdin?: string,
): Promise<RecordResult> {
  const value = await invokeSuccess(env, cwd, argv, stdin);
  return readRecordResult(value);
}

/**
 * Декодирует общие поля карточки из одиночного или составного ответа бинарника.
 * Предметные ожидания остаются независимыми утверждениями пользовательского маршрута.
 */
export function readRecordResult(value: unknown): RecordResult {
  if (
    !isObject(value) ||
    typeof value.id !== "string" ||
    typeof value.key !== "string" ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !isObject(value.data)
  ) {
    throw new Error("Ожидалась карточка с ID, ключом, положительной ревизией и объектом data");
  }
  return { ...value, id: value.id, key: value.key, revision: value.revision, data: value.data };
}

/**
 * Выполняет ожидаемо отклонённую команду, проверяет код завершения и пустой stdout.
 * Возвращает предметный код JSON-ошибки для независимого утверждения в маршруте.
 */
export async function invokeFailure(
  env: WorkflowEnvironment,
  cwd: string,
  argv: readonly string[],
  exitCode: number,
): Promise<string> {
  const result = await env.invoke(cwd, [...argv, "--format", "json"]);
  expect(result).toMatchObject({ code: exitCode, stdout: "" });
  const response: unknown = JSON.parse(result.stderr);
  if (
    !isObject(response) ||
    response.ok !== false ||
    !isObject(response.error) ||
    typeof response.error.code !== "string"
  ) {
    throw new Error("Отклонённая команда должна вернуть JSON с ok: false и кодом error.code");
  }
  return response.error.code;
}

/**
 * Проверяет единственный созданный элемент состава и возвращает его постоянный ID.
 */
export function singleEntryId(value: unknown): string {
  if (!Array.isArray(value)) {
    throw new Error("Ожидался массив с единственным созданным элементом");
  }
  expect(value).toHaveLength(1);
  const entry: unknown = value[0];
  if (!isObject(entry) || typeof entry.id !== "string" || entry.id.length === 0) {
    throw new Error("Созданный элемент должен иметь непустой постоянный ID");
  }
  return entry.id;
}

/**
 * Проверяет непустой ID текущего участия перед передачей его следующей команде истории.
 */
export function currentRunId(session: RecordResult): string {
  const value = session.data.currentRunId;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Открытая сессия должна содержать ID текущего участия");
  }
  return value;
}
