import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const binary = resolve(import.meta.dir, "../../apps/cli/dist/relay");
const artifacts = resolve(
  import.meta.dir,
  "../../.artifacts",
  new Date().toISOString().slice(0, 10),
);

interface RecordResult {
  id: string;
  key: string;
  revision: number;
  data: Record<string, unknown>;
}

/** Каждый шаг запускает новый бинарник: сценарий проверяет именно сохранённое состояние. */
async function environment() {
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(join(artifacts, "local-workflow-"));
  const home = join(root, "home");
  await mkdir(home);
  return {
    root,
    async invoke(cwd: string, argv: string[], stdin?: string) {
      const child = Bun.spawn([binary, ...argv], {
        cwd,
        env: { HOME: home, RELAY_HOME: join(home, ".relay") },
        stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
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
    async close() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

type Environment = Awaited<ReturnType<typeof environment>>;

async function success(env: Environment, cwd: string, argv: string[], stdin?: string) {
  const result = await env.invoke(cwd, [...argv, "--format", "json"], stdin);
  expect(result, `Неуспешная команда: ${argv.join(" ")}`).toMatchObject({ code: 0, stderr: "" });
  const response = JSON.parse(result.stdout) as { ok: boolean; data: unknown };
  expect(response.ok).toBe(true);
  return response.data;
}

test("документ сохраняет полный Markdown между процессами и защищён прочитанной ревизией", async () => {
  const env = await environment();
  try {
    const cwd = join(env.root, "Проект с пробелами");
    await mkdir(cwd);
    await success(env, cwd, ["init", "--name", "Библиотека", "--slug", "library"]);
    const body = "# Правила\n\n  Значимый отступ\n\n```ts\nconst value = '$HOME';\n```\n";
    const created = (await success(
      env,
      cwd,
      ["document", "create", "--name", "Исходное ТЗ", "--body-file", "-", "--actor", "human"],
      body,
    )) as RecordResult;
    const read = (await success(env, cwd, ["document", "get", created.key])) as RecordResult;
    expect(read.data.body).toBe(body);
    expect(read.id).toBe(created.id);

    await success(env, cwd, [
      "document",
      "update",
      created.key,
      "--body",
      "Уточнённые требования\n",
      "--if-revision",
      String(read.revision),
      "--actor",
      "editor",
    ]);
    const stale = await env.invoke(cwd, [
      "document",
      "update",
      created.key,
      "--body",
      "Устаревшее изменение",
      "--if-revision",
      String(read.revision),
      "--actor",
      "human",
    ]);
    expect(stale.code).toBe(4);
    expect(stale.stdout).toBe("");
    expect(stale.stderr).not.toBe("");
    const current = (await success(env, cwd, ["document", "get", created.id])) as RecordResult;
    expect(current.data.body).toBe("Уточнённые требования\n");
    expect(current.revision).toBe(read.revision + 1);
  } finally {
    await env.close();
  }
});

test("workspace выбирает независимые проекты и удаляет регистрацию с сохранением базы", async () => {
  const env = await environment();
  try {
    const alpha = join(env.root, "alpha");
    const beta = join(env.root, "beta");
    const workspace = join(env.root, "workspace");
    await Promise.all([alpha, beta, workspace].map((path) => mkdir(path)));
    await success(env, alpha, ["init", "--name", "Альфа", "--slug", "alpha"]);
    await success(env, beta, ["init", "--name", "Бета", "--slug", "beta"]);
    await success(env, workspace, ["workspace", "project", "init"]);
    await success(env, workspace, ["workspace", "project", "add", "alpha", "../alpha"]);
    await success(env, workspace, ["workspace", "project", "add", "beta", "../beta"]);
    const first = (await success(env, workspace, [
      "document",
      "create",
      "--name",
      "Только Альфа",
      "--body",
      "Данные Альфы",
      "--actor",
      "human",
      "--project",
      "alpha",
    ])) as RecordResult;
    const second = (await success(env, workspace, [
      "document",
      "create",
      "--name",
      "Только Бета",
      "--body",
      "Данные Беты",
      "--actor",
      "human",
      "--project",
      "beta",
    ])) as RecordResult;
    expect(first.key).toBe(second.key);
    expect(first.id).not.toBe(second.id);
    const read = (await success(env, workspace, [
      "document",
      "get",
      first.key,
      "--project",
      "alpha",
    ])) as RecordResult;
    expect(read.data.body).toBe("Данные Альфы");

    const ambiguous = await env.invoke(workspace, ["project", "get"]);
    expect(ambiguous.code).not.toBe(0);
    await success(env, workspace, ["workspace", "project", "remove", "alpha"]);
    const preserved = (await success(env, alpha, ["document", "get", first.key])) as RecordResult;
    expect(preserved.id).toBe(first.id);
    expect(preserved.data.body).toBe("Данные Альфы");
  } finally {
    await env.close();
  }
});

test("задача с критерием проходит через завершённый план до записи релиза", async () => {
  const env = await environment();
  try {
    const cwd = join(env.root, "project");
    await mkdir(cwd);
    await success(env, cwd, ["init", "--name", "Задачи", "--slug", "tasks"]);
    const task = (await success(env, cwd, [
      "task",
      "create",
      "--board",
      "product",
      "--title",
      "Проверить ввод",
      "--actor",
      "human",
    ])) as RecordResult;
    const withCriterion = (await success(env, cwd, [
      "task",
      "criterion",
      "add",
      task.key,
      "--title",
      "Текст сохранён",
      "--if-revision",
      String(task.revision),
      "--actor",
      "human",
    ])) as RecordResult;
    const blocked = await env.invoke(cwd, [
      "task",
      "move",
      task.key,
      "--column",
      "done",
      "--if-revision",
      String(withCriterion.revision),
      "--actor",
      "human",
    ]);
    expect(blocked.code).not.toBe(0);
    const criteria = withCriterion.data.acceptanceCriteria as Array<{ id: string }>;
    expect(criteria).toHaveLength(1);
    const checked = (await success(env, cwd, [
      "task",
      "criterion",
      "complete",
      task.key,
      criteria[0]!.id,
      "--if-revision",
      String(withCriterion.revision),
      "--actor",
      "human",
    ])) as RecordResult;
    const completed = (await success(env, cwd, [
      "task",
      "move",
      task.key,
      "--column",
      "done",
      "--if-revision",
      String(checked.revision),
      "--actor",
      "human",
    ])) as RecordResult;
    expect(completed.data.column).toBe("done");
    const progress = await success(env, cwd, ["task", "progress", task.key]);
    expect(progress).toMatchObject({ completed: true, canComplete: true });

    let plan = (await success(env, cwd, [
      "plan",
      "create",
      "--title",
      "Проверка ввода",
      "--goal",
      "Сохранить текст без потерь",
      "--actor",
      "human",
    ])) as RecordResult;
    plan = (await success(env, cwd, [
      "plan",
      "stage",
      "create",
      plan.key,
      "--title",
      "Реализация",
      "--if-revision",
      String(plan.revision),
      "--actor",
      "human",
    ])) as RecordResult;
    const stageId = (plan.data.stages as Array<{ id: string }>)[0]!.id;
    plan = (await success(env, cwd, [
      "plan",
      "stage",
      "task",
      "add",
      plan.key,
      stageId,
      task.key,
      "--if-revision",
      String(plan.revision),
      "--actor",
      "human",
    ])) as RecordResult;
    plan = (await success(env, cwd, [
      "plan",
      "complete",
      plan.key,
      "--result",
      "Ввод проверен по критерию задачи.",
      "--if-revision",
      String(plan.revision),
      "--actor",
      "human",
    ])) as RecordResult;
    expect(plan.data.status).toBe("completed");
    let release = (await success(env, cwd, [
      "release",
      "create",
      "--title",
      "Первый выпуск",
      "--release-version",
      "0.1.0",
      "--plans",
      plan.key,
      "--actor",
      "human",
    ])) as RecordResult;
    release = (await success(env, cwd, [
      "release",
      "publish",
      release.key,
      "--if-revision",
      String(release.revision),
      "--actor",
      "human",
    ])) as RecordResult;
    expect(release.data.status).toBe("released");
    expect(release.data.planIds).toEqual([plan.id]);
  } finally {
    await env.close();
  }
});

test("история работы сохраняет неизменяемое намерение и явный результат участия", async () => {
  const env = await environment();
  try {
    const cwd = join(env.root, "history");
    await mkdir(cwd);
    await success(env, cwd, ["init", "--name", "История", "--slug", "history"]);
    let session = (await success(env, cwd, [
      "session",
      "start",
      "--title",
      "Проверить пользовательский сценарий",
      "--actor",
      "agent",
    ])) as RecordResult;
    const run = session.data.currentRunId;
    expect(typeof run).toBe("string");
    const intent = (await success(env, cwd, [
      "checkpoint",
      "open",
      session.key,
      "--title",
      "Намерение",
      "--body",
      "Сохранить исходное описание проверки.",
      "--run",
      String(run),
      "--if-revision",
      String(session.revision),
      "--actor",
      "agent",
    ])) as RecordResult;
    session = (await success(env, cwd, ["session", "get", session.key])) as RecordResult;
    const result = (await success(env, cwd, [
      "checkpoint",
      "complete",
      intent.key,
      "--title",
      "Результат",
      "--body",
      "Описание прочитано и сверено.",
      "--run",
      String(run),
      "--if-revision",
      String(session.revision),
      "--actor",
      "agent",
    ])) as RecordResult;
    expect(result.id).not.toBe(intent.id);
    const original = (await success(env, cwd, ["checkpoint", "get", intent.key])) as RecordResult;
    expect(original).toEqual(intent);
    session = (await success(env, cwd, ["session", "get", session.key])) as RecordResult;
    const completed = (await success(env, cwd, [
      "session",
      "complete",
      session.key,
      "--result",
      "Пользовательский сценарий проверен.",
      "--run",
      String(run),
      "--if-revision",
      String(session.revision),
      "--actor",
      "agent",
    ])) as RecordResult;
    expect(completed.data.status).toBe("completed");
    expect(completed.data.currentRunId).toBeNull();
    expect(completed.data.result).toBe("Пользовательский сценарий проверен.");
  } finally {
    await env.close();
  }
});
