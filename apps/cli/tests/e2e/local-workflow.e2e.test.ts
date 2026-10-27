import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createWorkflowEnvironment,
  currentRunId,
  invokeFailure,
  invokeRecord,
  invokeSuccess,
  singleEntryId,
} from "./helpers/workflow-fixture";

describe("Локальные маршруты через поставляемый бинарник", () => {
  test("документ сохраняет полный Markdown между процессами и защищён прочитанной ревизией", async () => {
    const env = await createWorkflowEnvironment();
    try {
      const cwd = join(env.root, "Проект с пробелами");
      await mkdir(cwd);
      await invokeSuccess(env, cwd, ["init", "--name", "Библиотека", "--slug", "library"]);
      const body = "# Правила\n\n  Значимый отступ\n\n```ts\nconst value = '$HOME';\n```\n";
      const created = await invokeRecord(
        env,
        cwd,
        ["document", "create", "--name", "Исходное ТЗ", "--body-file", "-", "--actor", "human"],
        body,
      );

      const read = await invokeRecord(env, cwd, ["document", "get", created.key]);

      expect(read.data.body).toBe(body);
      expect(read.id).toBe(created.id);

      await invokeSuccess(env, cwd, [
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
      const staleCode = await invokeFailure(
        env,
        cwd,
        [
          "document",
          "update",
          created.key,
          "--body",
          "Устаревшее изменение",
          "--if-revision",
          String(read.revision),
          "--actor",
          "human",
        ],
        4,
      );

      expect(staleCode).toBe("REVISION_CONFLICT");
      const current = await invokeRecord(env, cwd, ["document", "get", created.id]);
      expect(current.data.body).toBe("Уточнённые требования\n");
      expect(current.revision).toBe(read.revision + 1);
    } finally {
      await env.close();
    }
  });

  test("workspace выбирает независимые проекты и удаляет регистрацию с сохранением базы", async () => {
    const env = await createWorkflowEnvironment();
    try {
      const alpha = join(env.root, "alpha");
      const beta = join(env.root, "beta");
      const workspace = join(env.root, "workspace");
      await Promise.all([alpha, beta, workspace].map((path) => mkdir(path)));
      await invokeSuccess(env, alpha, ["init", "--name", "Альфа", "--slug", "alpha"]);
      await invokeSuccess(env, beta, ["init", "--name", "Бета", "--slug", "beta"]);
      await invokeSuccess(env, workspace, ["workspace", "project", "init"]);
      await invokeSuccess(env, workspace, ["workspace", "project", "add", "alpha", "../alpha"]);
      await invokeSuccess(env, workspace, ["workspace", "project", "add", "beta", "../beta"]);

      const first = await invokeRecord(env, workspace, [
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
      ]);
      const second = await invokeRecord(env, workspace, [
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
      ]);

      expect(first.key).toBe(second.key);
      expect(first.id).not.toBe(second.id);
      const read = await invokeRecord(env, workspace, [
        "document",
        "get",
        first.key,
        "--project",
        "alpha",
      ]);
      expect(read.data.body).toBe("Данные Альфы");

      const ambiguousCode = await invokeFailure(env, workspace, ["project", "get"], 2);

      expect(ambiguousCode).toBe("PROJECT_REQUIRED");
      await invokeSuccess(env, workspace, ["workspace", "project", "remove", "alpha"]);
      const preserved = await invokeRecord(env, alpha, ["document", "get", first.key]);
      expect(preserved.id).toBe(first.id);
      expect(preserved.data.body).toBe("Данные Альфы");
    } finally {
      await env.close();
    }
  });

  test("задача с критерием проходит через завершённый план до записи релиза", async () => {
    const env = await createWorkflowEnvironment();
    try {
      const cwd = join(env.root, "project");
      await mkdir(cwd);
      await invokeSuccess(env, cwd, ["init", "--name", "Задачи", "--slug", "tasks"]);
      const task = await invokeRecord(env, cwd, [
        "task",
        "create",
        "--board",
        "product",
        "--title",
        "Проверить ввод",
        "--actor",
        "human",
      ]);
      const withCriterion = await invokeRecord(env, cwd, [
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
      ]);

      const blockedCode = await invokeFailure(
        env,
        cwd,
        [
          "task",
          "move",
          task.key,
          "--column",
          "done",
          "--if-revision",
          String(withCriterion.revision),
          "--actor",
          "human",
        ],
        2,
      );

      expect(blockedCode).toBe("TASK_INCOMPLETE");
      const unchanged = await invokeRecord(env, cwd, ["task", "get", task.key]);
      expect(unchanged).toEqual(withCriterion);
      const criterionId = singleEntryId(withCriterion.data.acceptanceCriteria);
      const checked = await invokeRecord(env, cwd, [
        "task",
        "criterion",
        "complete",
        task.key,
        criterionId,
        "--if-revision",
        String(withCriterion.revision),
        "--actor",
        "human",
      ]);
      const completed = await invokeRecord(env, cwd, [
        "task",
        "move",
        task.key,
        "--column",
        "done",
        "--if-revision",
        String(checked.revision),
        "--actor",
        "human",
      ]);

      expect(completed.data.column).toBe("done");
      const progress = await invokeSuccess(env, cwd, ["task", "progress", task.key]);
      expect(progress).toMatchObject({ completed: true, canComplete: true });

      let plan = await invokeRecord(env, cwd, [
        "plan",
        "create",
        "--title",
        "Проверка ввода",
        "--goal",
        "Сохранить текст без потерь",
        "--actor",
        "human",
      ]);
      plan = await invokeRecord(env, cwd, [
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
      ]);
      const stageId = singleEntryId(plan.data.stages);
      plan = await invokeRecord(env, cwd, [
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
      ]);
      plan = await invokeRecord(env, cwd, [
        "plan",
        "complete",
        plan.key,
        "--result",
        "Ввод проверен по критерию задачи.",
        "--if-revision",
        String(plan.revision),
        "--actor",
        "human",
      ]);

      expect(plan.data.status).toBe("completed");
      let release = await invokeRecord(env, cwd, [
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
      ]);
      release = await invokeRecord(env, cwd, [
        "release",
        "publish",
        release.key,
        "--if-revision",
        String(release.revision),
        "--actor",
        "human",
      ]);

      expect(release.data.status).toBe("released");
      expect(release.data.planIds).toEqual([plan.id]);
    } finally {
      await env.close();
    }
  });

  test("история работы сохраняет неизменяемое намерение и явный результат участия", async () => {
    const env = await createWorkflowEnvironment();
    try {
      const cwd = join(env.root, "history");
      await mkdir(cwd);
      await invokeSuccess(env, cwd, ["init", "--name", "История", "--slug", "history"]);
      let session = await invokeRecord(env, cwd, [
        "session",
        "start",
        "--title",
        "Проверить пользовательский сценарий",
        "--actor",
        "agent",
      ]);
      const run = currentRunId(session);
      const intent = await invokeRecord(env, cwd, [
        "checkpoint",
        "open",
        session.key,
        "--title",
        "Намерение",
        "--body",
        "Сохранить исходное описание проверки.",
        "--run",
        run,
        "--if-revision",
        String(session.revision),
        "--actor",
        "agent",
      ]);
      session = await invokeRecord(env, cwd, ["session", "get", session.key]);

      const result = await invokeRecord(env, cwd, [
        "checkpoint",
        "complete",
        intent.key,
        "--title",
        "Результат",
        "--body",
        "Описание прочитано и сверено.",
        "--run",
        run,
        "--if-revision",
        String(session.revision),
        "--actor",
        "agent",
      ]);

      expect(result.id).not.toBe(intent.id);
      const original = await invokeRecord(env, cwd, ["checkpoint", "get", intent.key]);
      expect(original).toEqual(intent);
      session = await invokeRecord(env, cwd, ["session", "get", session.key]);
      const completed = await invokeRecord(env, cwd, [
        "session",
        "complete",
        session.key,
        "--result",
        "Пользовательский сценарий проверен.",
        "--run",
        run,
        "--if-revision",
        String(session.revision),
        "--actor",
        "agent",
      ]);

      expect(completed.data.status).toBe("completed");
      expect(completed.data.currentRunId).toBeNull();
      expect(completed.data.result).toBe("Пользовательский сценарий проверен.");
    } finally {
      await env.close();
    }
  });
});
