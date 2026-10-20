import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { EntityRecord } from "@relay/contracts";
import { ProjectDatabase } from "@relay/storage";
import { runCli, type CliRuntime } from "../../src/run";

interface Envelope {
  data: EntityRecord & Record<string, unknown> & { items: EntityRecord[] };
  meta: {
    page: { nextCursor: string | null; nextCommand: string | null; count: number; total: number };
  };
}

let fixture: string;
let runtime: CliRuntime;
beforeEach(() => {
  const artifacts = resolve(
    import.meta.dir,
    "../../../../.artifacts",
    new Date().toISOString().slice(0, 10),
  );
  mkdirSync(artifacts, { recursive: true });
  fixture = mkdtempSync(join(artifacts, "cli-integration-"));
  const cwd = join(fixture, "project");
  mkdirSync(cwd);
  runtime = { cwd, env: { RELAY_HOME: join(fixture, "home"), RELAY_ACTOR: "agent" }, stdin: "" };
});
afterEach(() => rmSync(fixture, { recursive: true, force: true }));

async function invoke(argv: string[], context = runtime) {
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
    context,
  );
  return { code, stdout, stderr };
}
async function success(argv: string[], context = runtime): Promise<Envelope> {
  const answer = await invoke([...argv, "--format=json"], context);
  if (answer.code !== 0) throw new Error(`${argv.join(" ")}: ${answer.stderr}`);
  expect(answer.stderr).toBe("");
  return JSON.parse(answer.stdout) as Envelope;
}
const initialize = () => success(["init", "--name", "Проверка CLI", "--slug", "cli-test"]);

describe("CLI с настоящей SQLite", () => {
  test("повреждённый состав не подменяется успешной пустой страницей", async () => {
    const init = await initialize();
    expect((await success(["document", "section", "list"])).meta.page.total).toBe(0);
    const plan = (await success(["plan", "create", "--title", "Проверка состава"])).data;
    const database = ProjectDatabase.open(String(init.data.databasePath));
    try {
      database.update(
        { ...plan, revision: plan.revision + 1, data: { ...plan.data, stages: null } },
        plan.revision,
      );
      const generation = database.getGeneration();
      const malformedList = await invoke(["plan", "stage", "list", plan.key, "--format", "json"]);
      expect(malformedList.code).toBe(1);
      expect(malformedList.stdout).toBe("");
      expect(JSON.parse(malformedList.stderr).error.code).toBe("INVALID_DATA");
      expect(database.getGeneration()).toBe(generation);

      const current = database.get(plan.id)!;
      database.update(
        {
          ...current,
          revision: current.revision + 1,
          data: { ...current.data, stages: [{ id: "stage", taskIds: null }] },
        },
        current.revision,
      );
      const malformedReferences = await invoke([
        "plan",
        "stage",
        "task",
        "list",
        plan.key,
        "stage",
        "--format",
        "json",
      ]);
      expect(malformedReferences.code).toBe(1);
      expect(malformedReferences.stdout).toBe("");
      expect(JSON.parse(malformedReferences.stderr).error.code).toBe("INVALID_DATA");
    } finally {
      database.close();
    }
  });

  test("read actions работают при занятом писателе, мутации сохраняют блокировку записи", async () => {
    const init = await initialize();
    const writer = new Database(String(init.data.databasePath));
    writer.exec("BEGIN IMMEDIATE");
    try {
      for (const argv of [
        ["overview"],
        ["task", "list"],
        ["search", "--q", "Проверка"],
        ["doctor", "check"],
      ])
        await success(argv);
      const write = await invoke(["task", "create", "--title", "Ожидает писателя"]);
      expect(write.code).toBe(4);
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
    expect((await success(["task", "list"])).meta.page.total).toBe(0);
  });

  test("подмена файла между выбором и открытием не направляет запись в чужой проект", async () => {
    const init = await initialize();
    const path = String(init.data.databasePath);
    const foreignPath = join(fixture, "foreign.sqlite");
    const foreign = ProjectDatabase.create(foreignPath, {
      id: crypto.randomUUID(),
      name: "Чужой",
      slug: "foreign",
    });
    const foreignId = foreign.projectId;
    foreign.close();
    const open = ProjectDatabase.open;
    let opens = 0;
    const interception = spyOn(ProjectDatabase, "open").mockImplementation((selectedPath) => {
      if (selectedPath === path && ++opens === 2) copyFileSync(foreignPath, path);
      return open(selectedPath);
    });
    try {
      const answer = await invoke([
        "project",
        "update",
        "--name",
        "Не сохранять",
        "--if-revision",
        "1",
        "--format",
        "json",
      ]);
      expect(answer.code).toBe(4);
      const error = JSON.parse(answer.stderr).error;
      expect(error.code).toBe("PROJECT_ID_MISMATCH");
      expect(error.details).toMatchObject({ expected: init.data.projectId, actual: foreignId });
    } finally {
      interception.mockRestore();
    }
    const database = ProjectDatabase.open(path);
    try {
      expect(database.get("PROJECT")!.data.name).toBe("Чужой");
    } finally {
      database.close();
    }
  });

  test("search/inspect используют алиасы и типизированные адреса, а overview не теряет полные счётчики", async () => {
    await initialize();
    const task = (await success(["task", "create", "--title", "Необычное содержание"])).data;
    const feature = (
      await success(["feature", "create", "--name", "Фича", "--description", "Описание"])
    ).data;
    await success(["feature", "rename", feature.key, "FEATURE-RENAMED", "--if-revision", "1"]);
    expect((await success(["inspect", "resolve", `task:${task.id}`])).data.id).toBe(task.id);
    expect((await success(["inspect", "get", `feature:${feature.key}`])).data.id).toBe(feature.id);
    expect(
      (await success(["search", "--q", feature.key])).data.items.map((item) => item.id),
    ).toEqual([feature.id]);
    await success(["task", "comment", "add", task.key, "--body", "неискомый-комментарий"]);
    expect((await success(["search", "--q", "неискомый-комментарий"])).meta.page.total).toBe(0);
    const overview = await success(["overview", "--limit", "1"]);
    expect(overview.data.items).toHaveLength(1);
    expect(overview.data.counts).toMatchObject({ task: 1, feature: 1 });
    expect(overview.meta.page.total).toBe(5);
  });

  test("весь JSON проверяется до мутации, позиционные владельцы не перезаписывают неизвестные поля", async () => {
    await initialize();
    const plan = (await success(["plan", "create", "--input", '{"title":"План"}'])).data;
    const stage = (
      await success(["plan", "stage", "create", plan.key, "--title", "Этап", "--if-revision", "1"])
    ).data;
    const stageId = (stage.data.stages as Array<{ id: string }>)[0]!.id;
    for (const argv of [
      ["task", "create", "--input", '{"title":"Не сохранять","unknown":true}'],
      [
        "document",
        "section",
        "create",
        "local",
        "--input",
        '{"id":"ignored","name":"Не сохранять"}',
        "--if-revision",
        "1",
      ],
      [
        "plan",
        "stage",
        "update",
        plan.key,
        stageId,
        "--input",
        '{"stageId":"ignored","title":"Не сохранять"}',
        "--if-revision",
        "2",
      ],
      ["document", "create", "--input-file", "-"],
    ]) {
      const answer = await invoke(argv, {
        ...runtime,
        stdin: '{"name":"Не сохранять","body":"Текст","unknown":true}',
      });
      expect(answer.code).toBe(2);
      expect(answer.stdout).toBe("");
      expect(answer.stderr).toContain("Неизвестное поле");
    }
    expect((await success(["task", "list"])).meta.page.total).toBe(0);
    expect((await success(["document", "list"])).meta.page.total).toBe(0);
    expect((await success(["plan", "get", plan.key])).data.revision).toBe(2);
    const session = (
      await success([
        "session",
        "start",
        "--input",
        '{"title":"Поручение","operator":{"name":"Человек","email":null,"source":"explicit"}}',
      ])
    ).data;
    const point = await success([
      "checkpoint",
      "open",
      session.key,
      "--if-revision",
      "1",
      "--input",
      JSON.stringify({ runId: session.data.currentRunId, title: "Материал", body: "Содержание" }),
    ]);
    expect(point.data.data.runId).toBe(session.data.currentRunId);
  });

  test("длинный get сохраняет содержание, text обезвреживает контролы, JSON сохраняет исходные символы", async () => {
    await initialize();
    const body =
      "## Полное содержание\n\n" +
      "    Проверяемая строка\n".repeat(4_000) +
      "\u001b[31mКОНЕЦ\u001b[0m\u202e";
    const created = (
      await success(["document", "create", "--name", "Длинный", "--body-file", "-"], {
        ...runtime,
        stdin: body,
      })
    ).data;
    const json = await success(["document", "get", created.key]);
    expect(json.data.data.body).toBe(body);
    const text = await invoke(["document", "get", created.key]);
    expect(text.stdout).toContain(
      body.replace("\u001b[31m", "").replace("\u001b[0m", "").replace("\u202e", ""),
    );
    expect(text.stdout).not.toContain("\u001b");
    expect((await invoke(["document", "list"])).stdout).not.toContain("Проверяемая строка");
  });

  test("ошибки конфликтующих адресов Core выводятся без замены кода и не изменяют ключ", async () => {
    await initialize();
    const first = (
      await success([
        "application",
        "create",
        "--name",
        "Web",
        "--slug",
        "web",
        "--description",
        "Интерфейс",
      ])
    ).data;
    const second = (
      await success([
        "application",
        "create",
        "--name",
        "Backend",
        "--slug",
        "backend",
        "--description",
        "Обработка",
      ])
    ).data;
    const colon = await invoke([
      "application",
      "rename",
      first.key,
      "application:foreign",
      "--if-revision",
      String(first.revision),
      "--format",
      "json",
    ]);
    expect(colon.code).toBe(2);
    expect(JSON.parse(colon.stderr).error.code).toBe("VALIDATION_ERROR");
    const collision = await invoke([
      "application",
      "rename",
      first.key,
      "backend",
      "--if-revision",
      String(first.revision),
      "--format",
      "json",
    ]);
    expect(collision.code).toBe(4);
    expect(JSON.parse(collision.stderr).error.code).toBe("CONFLICT");
    expect((await success(["application", "get", `application:${second.id}`])).data.id).toBe(
      second.id,
    );
    expect((await success(["application", "get", first.id])).data.key).toBe(first.key);
  });
  test("Gunshi разбирает глобальные опции на каждом уровне, флаги имеют приоритет над env", async () => {
    const init = await initialize();
    const context = {
      ...runtime,
      env: {
        ...runtime.env,
        RELAY_CONFIG: join(fixture, "missing.json"),
        RELAY_ACTOR: "environment",
      },
    };
    const globals = [
      "--config",
      String(init.data.configPath),
      "--actor",
      "task",
      "--format",
      "json",
    ];
    for (const argv of [
      [...globals, "task", "create", "--title", "Перед командой"],
      ["task", ...globals, "create", "--title", "Между командами"],
      ["task", "create", "--title", "После команды", ...globals],
    ]) {
      const answer = await invoke(argv, context);
      expect(answer.code).toBe(0);
      expect(answer.stderr).toBe("");
      expect(JSON.parse(answer.stdout).data.createdBy).toBe("task");
    }
  });
  test("глобальные параметры работают до, между и после вложенных команд; ревизии и алиасы сохраняются", async () => {
    const init = await initialize();
    const config = String(init.data.configPath);
    const created = await success([
      "--actor",
      "writer",
      "--config",
      config,
      "feature",
      "--format",
      "json",
      "create",
      "--name",
      "Поиск",
      "--description",
      "# Требования\n\n    точный текст\n",
    ]);
    expect(created.data.createdBy).toBe("writer");
    const ref = created.data.key;
    const text = await invoke(["feature", "get", ref, "--config", config]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("# Требования\n\n    точный текст\n");
    const renamed = await success([
      "feature",
      "rename",
      ref,
      "SEARCH",
      "--if-revision",
      String(created.data.revision),
    ]);
    expect((await success(["feature", "get", ref])).data.id).toBe(created.data.id);
    const conflict = await invoke([
      "feature",
      "update",
      "SEARCH",
      "--summary",
      "не сохранять",
      "--if-revision",
      "1",
      "--format",
      "json",
    ]);
    expect(conflict.code).toBe(4);
    expect(JSON.parse(conflict.stderr).error.code).toBe("REVISION_CONFLICT");
    expect((await success(["feature", "get", "SEARCH"])).data.revision).toBe(renamed.data.revision);
    const missingRevision = await invoke([
      "feature",
      "update",
      "SEARCH",
      "--summary",
      "не сохранять",
    ]);
    expect(missingRevision.code).toBe(2);
    expect(missingRevision.stderr).toContain("--if-revision");
    expect((await invoke(["feature", "get", "absent"])).code).toBe(3);
  });

  test("страницы привязаны к запросу, проекту и поколению; список не печатает полный Markdown", async () => {
    await initialize();
    for (let n = 0; n < 3; n++)
      await success([
        "document",
        "create",
        "--name",
        `Документ ${n}`,
        "--body",
        "полное скрытое содержание",
      ]);
    const first = await success(["document", "list", "--limit", "1"]);
    expect(first.meta.page.total).toBe(3);
    const cursor = first.meta.page.nextCursor!;
    const second = await success(["document", "list", "--cursor", cursor]);
    expect(second.meta.page.count).toBe(1);
    expect(second.data.items[0]!.id).not.toBe(first.data.items[0]!.id);
    expect(first.meta.page.nextCommand).toContain("--config=");
    expect((await invoke(["document", "list", "--limit", "1"])).stdout).not.toContain(
      "полное скрытое содержание",
    );
    expect((await invoke(["document", "list", "--q", "другой", "--cursor", cursor])).code).toBe(2);
    const other = join(fixture, "other");
    mkdirSync(other);
    const another = { ...runtime, cwd: other };
    await success(["init", "--name", "Другой", "--slug", "other"], another);
    expect((await invoke(["document", "list", "--cursor", cursor], another)).code).toBe(2);
    await success(["task", "create", "--title", "Изменение поколения"]);
    expect((await invoke(["document", "list", "--cursor", cursor])).code).toBe(4);
  });

  test("файлы и stdin читаются до записи; двойной источник и неизвестные аргументы не меняют базу", async () => {
    await initialize();
    writeFileSync(join(runtime.cwd, "body.md"), "## Из файла\n\n  отступ\n");
    const document = await success([
      "document",
      "create",
      "--name",
      "Файл",
      "--body-file",
      "body.md",
    ]);
    expect(document.data.data.body).toBe("## Из файла\n\n  отступ\n");
    const update = await success(
      ["document", "update", document.data.key, "--body-file", "-", "--if-revision", "1"],
      { ...runtime, stdin: "\n# stdin\n" },
    );
    expect(update.data.data.body).toBe("\n# stdin\n");
    const invalid = [
      ["document", "create", "--name", "Два", "--body", "A", "--body-file", "-"],
      ["document", "create", "--name", "Два stdin", "--body-file", "-", "--summary-file", "-"],
      ["document", "create", "--input", "{}", "--name", "Конфликт"],
      ["task", "create", "--titel", "Опечатка"],
      ["task", "get", "PRODUCT-1", "лишний"],
      ["document", "create", "--name", "Ошибка", "--body-file", "missing.md"],
    ];
    for (const args of invalid) expect((await invoke(args)).code).toBe(2);
    expect((await success(["document", "list"])).meta.page.total).toBe(1);
  });

  test("разделы, связи, участие приложения и реальные диагностические команды", async () => {
    const init = await initialize();
    const feature = (
      await success(["feature", "create", "--name", "Фича", "--description", "Требования"])
    ).data;
    const app = (
      await success([
        "application",
        "create",
        "--name",
        "Web",
        "--slug",
        "web",
        "--description",
        "Интерфейс",
      ])
    ).data;
    const participation = (
      await success([
        "application",
        "participation",
        "replace",
        app.key,
        "--targets",
        feature.key,
        "--if-revision",
        String(app.revision),
      ])
    ).data;
    expect((await success(["application", "participation", "list", app.key])).meta.page.total).toBe(
      1,
    );
    expect(participation.revision).toBeGreaterThan(app.revision);
    await success([
      "document",
      "section",
      "create",
      "rules",
      "--name",
      "Правила",
      "--if-revision",
      "1",
    ]);
    const doc = (
      await success([
        "document",
        "create",
        "--name",
        "Правила",
        "--body",
        "# Правила",
        "--section-id",
        "rules",
      ])
    ).data;
    await success([
      "document",
      "link",
      doc.key,
      "--target",
      feature.key,
      "--description",
      "Основание",
      "--if-revision",
      "1",
    ]);
    expect((await success(["document", "links", doc.key])).meta.page.total).toBe(1);
    expect(
      (await success(["search", "--q", "Основание", "--kind", "document"])).meta.page.total,
    ).toBe(1);
    expect((await success(["storage", "status"])).data.projectId).toBe(init.data.projectId);
    expect((await success(["doctor", "check"])).data.valid).toBe(true);
    const db = ProjectDatabase.open(String(init.data.databasePath));
    const broken = db.get(doc.id)!;
    db.update(
      { ...broken, revision: broken.revision + 1, data: { ...broken.data, targets: ["absent"] } },
      broken.revision,
    );
    db.close();
    const check = await invoke(["doctor", "check"]);
    expect(check.code).toBe(1);
    expect(check.stderr).toContain("absent");
  });

  test("критерии, зависимости, состав плана и выпуск релиза проходят через предметные сервисы", async () => {
    await initialize();
    const task = (
      await success([
        "task",
        "create",
        "--title",
        "Работа",
        "--acceptance-criteria",
        '[{"title":"Проверено"}]',
      ])
    ).data;
    const criteria = await success(["task", "criterion", "list", task.key]);
    const id = String(criteria.data.items[0]!.id);
    await success(["task", "criterion", "complete", task.key, id, "--if-revision", "1"]);
    await success(["task", "move", task.key, "--column", "done", "--if-revision", "2"]);
    expect((await success(["task", "progress", task.key])).data.completed).toBe(true);
    const plan = (
      await success(["plan", "create", "--title", "План", "--goal", "Проверенный результат"])
    ).data;
    const withStage = (
      await success(["plan", "stage", "create", plan.key, "--title", "Этап", "--if-revision", "1"])
    ).data;
    const stage = (withStage.data.stages as Array<{ id: string }>)[0]!.id;
    await success([
      "plan",
      "stage",
      "task",
      "add",
      plan.key,
      stage,
      task.key,
      "--if-revision",
      "2",
    ]);
    expect((await success(["plan", "task", "memberships", task.key])).meta.page.total).toBe(1);
    await success(["plan", "complete", plan.key, "--result", "Проверено", "--if-revision", "3"]);
    const release = (
      await success([
        "release",
        "create",
        "--title",
        "Выпуск",
        "--release-version",
        "1.0.0",
        "--plans",
        plan.key,
      ])
    ).data;
    expect((await success(["release", "plans", release.key])).meta.page.total).toBe(1);
    await success([
      "release",
      "update",
      release.key,
      "--input",
      JSON.stringify({ version: "1.0.1", planIds: [plan.key] }),
      "--if-revision",
      "1",
    ]);
    const published = (await success(["release", "publish", release.key, "--if-revision", "2"]))
      .data;
    expect(published.data.status).toBe("released");
  });

  test("история сохраняет текущий run и материалы без Git и внешнего процесса", async () => {
    await initialize();
    const session = (
      await success([
        "session",
        "start",
        "--title",
        "Поручение",
        "--description",
        "Исследовать",
        "--user-name",
        "Человек",
      ])
    ).data;
    const run = String(session.data.currentRunId);
    const point = (
      await success([
        "checkpoint",
        "open",
        session.key,
        "--run",
        run,
        "--title",
        "Проверить",
        "--body",
        "План проверки",
        "--if-revision",
        "1",
      ])
    ).data;
    expect(point.data.runId).toBe(run);
    expect((await success(["session", "intents", session.key])).meta.page.total).toBe(1);
    await success([
      "checkpoint",
      "complete",
      point.key,
      "--run",
      run,
      "--title",
      "Проверено",
      "--body",
      "Полный результат",
      "--if-revision",
      "2",
    ]);
    await success([
      "session",
      "complete",
      session.key,
      "--run",
      run,
      "--result",
      "Поручение выполнено",
      "--if-revision",
      "3",
    ]);
    expect((await success(["session", "history", session.key])).meta.page.total).toBe(2);
    expect((await success(["session", "get", session.key])).data.data.status).toBe("completed");
    expect((await success(["doctor", "check"])).data.valid).toBe(true);
  });

  test("родитель, зависимости и комментарии используют разные предметные операции", async () => {
    await initialize();
    const first = (await success(["task", "create", "--title", "Родитель"])).data;
    const second = (await success(["task", "create", "--title", "Ребёнок"])).data;
    await success(["task", "parent", "set", second.key, first.key, "--if-revision", "1"]);
    expect((await success(["task", "children", first.key])).meta.page.total).toBe(1);
    await success(["task", "parent", "clear", second.key, "--if-revision", "2"]);
    await success(["task", "dependency", "add", second.key, first.key, "--if-revision", "3"]);
    expect((await success(["task", "dependency", "list", second.key])).data.items[0]!.id).toBe(
      first.id,
    );
    await success([
      "task",
      "comment",
      "add",
      second.key,
      "--title",
      "Наблюдение",
      "--body",
      "Полный текст комментария",
    ]);
    expect(
      (
        await invoke([
          "task",
          "comment",
          "add",
          second.key,
          "--input",
          '{"body":"не сохранять","unknown":true}',
        ])
      ).code,
    ).toBe(2);
    const comments = await success(["task", "comment", "list", second.key]);
    expect(comments.meta.page.total).toBe(1);
    const commentId = comments.data.items[0]!.id;
    expect((await success(["task", "comment", "get", second.key, commentId])).data.body).toBe(
      "Полный текст комментария",
    );
    expect((await success(["task", "get", second.key])).data.revision).toBe(4);
    expect((await success(["task", "progress", second.key])).data.blockers).toEqual([first.id]);
  });

  test("workspace выбирает независимые локальные базы без сервера", async () => {
    const init = await initialize();
    const workspace = join(fixture, "workspace");
    mkdirSync(workspace);
    const context = { ...runtime, cwd: workspace };
    await success(["workspace", "project", "init"], context);
    await success(["workspace", "project", "add", "one", String(init.data.configPath)], context);
    expect((await success(["workspace", "project", "list"], context)).meta.page.total).toBe(1);
    expect((await invoke(["project", "get"], context)).code).toBe(2);
    expect((await success(["--project", "one", "project", "get"], context)).data.id).toBe(
      String(init.data.projectId),
    );
    await success(["workspace", "project", "remove", "one"], context);
    expect((await success(["workspace", "project", "list"], context)).meta.page.total).toBe(0);
    expect((await success(["project", "get"])).data.id).toBe(String(init.data.projectId));
  });
});
