import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { RelayError } from "@relay/contracts";
import { ProjectDatabase } from "@relay/storage";
import {
  initializeProject,
  initializeWorkspace,
  listProjects,
  registerProject,
  resolveProject,
  unregisterProject,
} from "../../src";
import type { ProjectLocation, RuntimeOptions } from "../../src";

let root: string;
let cwd: string;
let home: string;
const children: Array<{ kill(): void; exited: Promise<number> }> = [];

beforeEach(() => {
  const artifacts = resolve(
    import.meta.dir,
    "../../../../.artifacts",
    new Date().toISOString().slice(0, 10),
  );
  mkdirSync(artifacts, { recursive: true });
  root = mkdtempSync(join(artifacts, "project-runtime-"));
  cwd = join(root, "work");
  home = join(root, "home");
  mkdirSync(cwd);
});

afterEach(async () => {
  for (const child of children) child.kill();
  await Promise.allSettled(children.splice(0).map((child) => child.exited));
  rmSync(root, { recursive: true, force: true });
});

function errorCode(operation: () => unknown): string {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(RelayError);
    return (error as RelayError).code;
  }
  throw new Error("Ожидался отказ операции");
}

function writeConfig(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data));
}

function launchInitialization(
  input: RuntimeOptions & { expectedHome?: string },
  env: Record<string, string | undefined> = process.env,
) {
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      join(import.meta.dir, "initialization-worker.ts"),
      JSON.stringify(input),
    ],
    cwd: root,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
    ipc(message) {
      if (message === "ready") markReady();
    },
  });
  children.push(child);
  return {
    child,
    ready,
    result: Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]),
  };
}

describe("инициализация и выбор локального проекта", () => {
  test("два проекта имеют независимые внешние базы с постоянными данными", () => {
    const first = initializeProject({ cwd, home, name: "Первый проект", slug: "first" });
    const second = initializeProject({ cwd: join(root, "second"), home, name: "Второй проект" });
    expect(first.databasePath).toBe(join(home, "projects", first.projectId, "project.sqlite"));
    expect(second.projectId).not.toBe(first.projectId);
    expect(first.configPath).toBe(join(cwd, ".relay", "config.json"));
    expect(JSON.parse(readFileSync(first.configPath, "utf8"))).toEqual({
      version: 1,
      projectId: first.projectId,
      databasePath: first.databasePath,
    });
    expect(readdirSync(join(cwd, ".relay"))).toEqual(["config.json"]);

    const firstDb = ProjectDatabase.open(first.databasePath);
    const secondDb = ProjectDatabase.open(second.databasePath);
    try {
      expect(firstDb.get("PROJECT")?.data).toEqual({ name: "Первый проект", slug: "first" });
      expect(secondDb.get("PROJECT")?.data.name).toBe("Второй проект");
      const now = new Date().toISOString();
      firstDb.insert({
        id: crypto.randomUUID(),
        kind: "document",
        key: "DOC-1",
        revision: 1,
        createdAt: now,
        updatedAt: now,
        createdBy: "test",
        updatedBy: "test",
        data: { title: "Только в первом" },
      });
      expect(secondDb.get("DOC-1")).toBeUndefined();
    } finally {
      firstDb.close();
      secondDb.close();
    }
    const reopened = ProjectDatabase.open(first.databasePath);
    try {
      expect(reopened.get("DOC-1")?.data.title).toBe("Только в первом");
    } finally {
      reopened.close();
    }
  });

  test("ищет вверх от вложенного cwd; явный config имеет приоритет над cwd", () => {
    const first = initializeProject({ cwd, home });
    const second = initializeProject({ cwd: join(root, "second"), home });
    const nested = join(cwd, "src", "deep");
    mkdirSync(nested, { recursive: true });
    expect(resolveProject({ cwd: nested, home })).toEqual(first);
    expect(
      resolveProject({
        cwd: nested,
        home,
        config: relative(nested, second.configPath),
      }),
    ).toEqual(second);
    expect(errorCode(() => resolveProject({ cwd: nested, home, config: "missing.json" }))).toBe(
      "CONFIG_NOT_FOUND",
    );
    expect(existsSync(join(nested, "missing.json"))).toBe(false);
  });

  test("проектный config вместе с --project отклоняется до открытия даже недоступной базы", () => {
    initializeWorkspace({ cwd, home });
    const alpha = initializeProject({ cwd: join(cwd, "alpha"), home });
    const beta = initializeProject({ cwd: join(cwd, "beta"), home });
    registerProject({ cwd, home }, "beta", beta.configPath);
    renameSync(alpha.databasePath, `${alpha.databasePath}.saved`);
    const open = spyOn(ProjectDatabase, "open");
    try {
      // Регистрация beta существует, но явный config указывает на alpha.
      // Ни отказ базы alpha, ни поиск родительского workspace не меняют смысл ввода.
      expect(
        errorCode(() => resolveProject({ cwd, home, config: alpha.configPath, project: "beta" })),
      ).toBe("WORKSPACE_REQUIRED");
      expect(open).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
    expect(errorCode(() => resolveProject({ cwd, home, config: alpha.configPath }))).toBe(
      "DATABASE_NOT_FOUND",
    );
    expect(resolveProject({ cwd, home, project: "beta" })).toEqual(beta);
    expect(existsSync(alpha.databasePath)).toBe(false);
  });

  test("повтор init и init из вложенного каталога не затирают проект", () => {
    const project = initializeProject({ cwd, home });
    const original = readFileSync(project.configPath, "utf8");
    const nested = join(cwd, "src", "deep");
    mkdirSync(nested, { recursive: true });
    expect(errorCode(() => initializeProject({ cwd, home, name: "Замена" }))).toBe("CONFIG_EXISTS");
    expect(errorCode(() => initializeProject({ cwd: nested, home }))).toBe("CONFIG_EXISTS");
    expect(readFileSync(project.configPath, "utf8")).toBe(original);
    expect(readdirSync(join(home, "projects"))).toEqual([project.projectId]);
    expect(existsSync(join(nested, ".relay"))).toBe(false);
    expect(resolveProject({ cwd, home })).toEqual(project);
  });

  test("init создаёт отсутствующий вложенный cwd и поддерживает явный путь конфига", () => {
    const nested = join(cwd, "new", "deep");
    const project = initializeProject({ cwd: nested, home });
    expect(resolveProject({ cwd: nested, home })).toEqual(project);
    const custom = initializeProject({ cwd, home, config: "settings/local.json" });
    expect(custom.configPath).toBe(join(cwd, "settings", "local.json"));
    expect(resolveProject({ cwd, home, config: "settings/local.json" })).toEqual(custom);
    expect(errorCode(() => initializeProject({ cwd, home, config: "settings/local.json" }))).toBe(
      "CONFIG_EXISTS",
    );
  });

  test("чтение отсутствующего проекта или workspace ничего не создаёт", () => {
    expect(errorCode(() => resolveProject({ cwd, home }))).toBe("PROJECT_NOT_FOUND");
    expect(errorCode(() => listProjects({ cwd, home }))).toBe("WORKSPACE_NOT_FOUND");
    expect(errorCode(() => unregisterProject({ cwd, home }, "absent"))).toBe("WORKSPACE_NOT_FOUND");
    expect(readdirSync(cwd)).toEqual([]);
    expect(existsSync(home)).toBe(false);
  });

  test("потерянная база не создаётся заново, ID чужой базы диагностируется", () => {
    const project = initializeProject({ cwd, home });
    const second = initializeProject({ cwd: join(root, "second"), home });
    writeConfig(project.configPath, {
      version: 1,
      projectId: project.projectId,
      databasePath: second.databasePath,
    });
    expect(errorCode(() => resolveProject({ cwd, home }))).toBe("PROJECT_ID_MISMATCH");
    const moved = `${project.databasePath}.saved`;
    renameSync(project.databasePath, moved);
    writeConfig(project.configPath, {
      version: 1,
      projectId: project.projectId,
      databasePath: project.databasePath,
    });
    expect(errorCode(() => resolveProject({ cwd, home }))).toBe("DATABASE_NOT_FOUND");
    expect(existsSync(project.databasePath)).toBe(false);
    expect(existsSync(moved)).toBe(true);
    expect(resolveProject({ cwd: join(root, "second"), home })).toEqual(second);
  });

  test("относительная ссылка на базу определяется каталогом конфига, включая symlink", () => {
    const project = initializeProject({ cwd, home });
    writeConfig(project.configPath, {
      version: 1,
      projectId: project.projectId,
      databasePath: relative(dirname(project.configPath), project.databasePath),
    });
    const link = join(root, "project.json");
    symlinkSync(project.configPath, link);
    expect(resolveProject({ cwd: root, home, config: link })).toEqual({
      ...project,
      configPath: link,
    });
  });
});

describe("имя и slug при инициализации", () => {
  test.each(["ab", "web-api-2", "a".repeat(64)])("сохраняет допустимый явный slug %s", (slug) => {
    const project = initializeProject({ cwd, home, name: "  Мой проект  ", slug });
    const database = ProjectDatabase.open(project.databasePath);
    try {
      expect(database.get("PROJECT")?.data).toEqual({ name: "Мой проект", slug });
    } finally {
      database.close();
    }
  });

  test.each([
    "",
    "a",
    "a".repeat(65),
    "Проект",
    "Upper",
    "with space",
    "a_b",
    "-start",
    "end-",
    "double--dash",
    "../path",
    "slug ",
    "slug\n",
  ])("отклоняет явный slug %j до создания файлов", (slug) => {
    const nested = join(cwd, "not-created", "project");
    expect(errorCode(() => initializeProject({ cwd: nested, home, slug }))).toBe(
      "INVALID_ARGUMENT",
    );
    expect(readdirSync(cwd)).toEqual([]);
    expect(existsSync(home)).toBe(false);
  });

  test.each(["Русское имя", "Я", "---", "a".repeat(65)])(
    "генерирует адрес от ID для имени %s",
    (name) => {
      const project = initializeProject({ cwd, home, name });
      const database = ProjectDatabase.open(project.databasePath);
      try {
        expect(database.get("PROJECT")?.data).toEqual({
          name,
          slug: `project-${project.projectId.slice(0, 8)}`,
        });
      } finally {
        database.close();
      }
    },
  );

  test("выводит latin kebab из подходящего имени", () => {
    const project = initializeProject({ cwd, home, name: "  Relay CLI 2  " });
    const database = ProjectDatabase.open(project.databasePath);
    try {
      expect(database.get("PROJECT")?.data).toEqual({ name: "Relay CLI 2", slug: "relay-cli-2" });
    } finally {
      database.close();
    }
  });

  test.each([" ", "a".repeat(121), "Первая\nВторая", "Первая\u2028Вторая", "Мой\tпроект"])(
    "отклоняет некорректное имя %j до создания файлов",
    (name) => {
      expect(errorCode(() => initializeProject({ cwd, home, name }))).toBe("INVALID_ARGUMENT");
      expect(readdirSync(cwd)).toEqual([]);
      expect(existsSync(home)).toBe(false);
    },
  );
});

describe("инициализация в отдельных процессах", () => {
  test("без home использует homedir/.relay, окружение RELAY_HOME оставляет вызывающей CLI", async () => {
    const expectedHome = join(root, "user");
    const worker = launchInitialization(
      { cwd, expectedHome },
      { ...process.env, HOME: expectedHome, RELAY_HOME: join(root, "ignored") },
    );
    await worker.ready;
    worker.child.send("go");
    const [exit, stdout, stderr] = await worker.result;
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    const result = JSON.parse(stdout) as { location: ProjectLocation };
    expect(result.location.databasePath).toBe(
      join(expectedHome, ".relay", "projects", result.location.projectId, "project.sqlite"),
    );
    expect(existsSync(join(root, "ignored"))).toBe(false);
  }, 15_000);

  test("два одновременных init публикуют один проект и не оставляют лишнюю базу", async () => {
    const workers = [launchInitialization({ cwd, home }), launchInitialization({ cwd, home })];
    await Promise.all(workers.map((worker) => worker.ready));
    for (const worker of workers) worker.child.send("go");
    const results: Array<{ code?: string; location?: ProjectLocation }> = [];
    for (const [exit, stdout, stderr] of await Promise.all(
      workers.map((worker) => worker.result),
    )) {
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
      results.push(JSON.parse(stdout));
    }
    expect(results.filter((result) => result.code === "CONFIG_EXISTS")).toHaveLength(1);
    const location = results.find((result) => result.location)?.location;
    expect(location).toBeDefined();
    if (!location) throw new Error("Ни одна попытка init не создала проект");
    expect(resolveProject({ cwd, home })).toEqual(location);
    expect(readdirSync(join(home, "projects"))).toEqual([location.projectId]);
    expect(readdirSync(join(cwd, ".relay"))).toEqual(["config.json"]);
  }, 15_000);
});

describe("диагностика конфигов", () => {
  test.each([
    ["не JSON", "{"],
    ["null", "null"],
    ["массив", "[]"],
    ["будущая версия", JSON.stringify({ version: 2, projectId: "id", databasePath: "/missing" })],
    ["неполный проект", JSON.stringify({ version: 1, projectId: "id" })],
    ["пустой путь", JSON.stringify({ version: 1, projectId: "id", databasePath: "" })],
    ["нестроковый ID", JSON.stringify({ version: 1, projectId: 42, databasePath: "/missing" })],
    [
      "смешанные конфиги",
      JSON.stringify({ version: 1, projectId: "id", databasePath: "/missing", projects: [] }),
    ],
  ])("отвергает %s без побочных записей", (_name, contents) => {
    const path = join(cwd, ".relay", "config.json");
    mkdirSync(dirname(path));
    writeFileSync(path, contents!);
    expect(errorCode(() => resolveProject({ cwd, home }))).toBe("INVALID_CONFIG");
    expect(errorCode(() => initializeProject({ cwd, home }))).toBe("CONFIG_EXISTS");
    expect(readFileSync(path, "utf8")).toBe(contents);
    expect(existsSync(home)).toBe(false);
  });

  test("повреждённый ближайший конфиг не пропускается ради родительского", () => {
    initializeProject({ cwd, home });
    const nested = join(cwd, "nested");
    writeConfig(join(nested, ".relay", "config.json"), {});
    expect(errorCode(() => resolveProject({ cwd: nested, home }))).toBe("INVALID_CONFIG");
  });

  test("конфиг-каталог и битая символьная ссылка не перезаписываются", () => {
    const path = join(cwd, ".relay", "config.json");
    mkdirSync(path, { recursive: true });
    expect(errorCode(() => resolveProject({ cwd, home }))).toBe("INVALID_CONFIG");
    expect(errorCode(() => initializeProject({ cwd, home }))).toBe("CONFIG_EXISTS");
    rmSync(path, { recursive: true });
    symlinkSync(join(root, "absent.json"), path);
    expect(errorCode(() => resolveProject({ cwd, home }))).toBe("CONFIG_NOT_FOUND");
    expect(errorCode(() => initializeProject({ cwd, home }))).toBe("CONFIG_EXISTS");
    expect(existsSync(home)).toBe(false);
  });
});

describe("локальные workspace-регистрации", () => {
  test("выбирает проект по имени из workspace, включая cwd внутри другого проекта", () => {
    const workspace = initializeWorkspace({ cwd, home });
    expect(listProjects({ cwd, home })).toEqual([]);
    const alpha = initializeProject({ cwd: join(cwd, "alpha"), home });
    const beta = initializeProject({ cwd: join(root, "beta"), home });
    registerProject({ cwd, home }, "alpha", "alpha");
    registerProject({ cwd, home }, "beta", beta.configPath);
    expect(listProjects({ cwd, home })).toEqual([
      { name: "alpha", configPath: alpha.configPath },
      { name: "beta", configPath: beta.configPath },
    ]);
    expect(errorCode(() => resolveProject({ cwd, home }))).toBe("PROJECT_REQUIRED");
    expect(resolveProject({ cwd, home, project: "alpha" })).toEqual(alpha);
    expect(resolveProject({ cwd: join(cwd, "alpha"), home, project: "beta" })).toEqual(beta);
    expect(
      resolveProject({ cwd: root, home, config: workspace.configPath, project: "beta" }),
    ).toEqual(beta);
    expect(
      errorCode(() => resolveProject({ cwd, home, config: alpha.configPath, project: "beta" })),
    ).toBe("WORKSPACE_REQUIRED");
    expect(errorCode(() => resolveProject({ cwd, home, project: "absent" }))).toBe(
      "PROJECT_NOT_FOUND",
    );
  });

  test("удаление регистрации сохраняет конфиг и данные; повторная регистрация идемпотентна", () => {
    initializeWorkspace({ cwd, home });
    const alpha = initializeProject({ cwd: join(root, "alpha"), home });
    const beta = initializeProject({ cwd: join(root, "beta"), home });
    registerProject({ cwd, home }, "alpha", alpha.configPath);
    registerProject({ cwd, home }, "alpha", alpha.configPath);
    expect(listProjects({ cwd, home })).toHaveLength(1);
    expect(errorCode(() => registerProject({ cwd, home }, "alpha", beta.configPath))).toBe(
      "PROJECT_EXISTS",
    );
    expect(unregisterProject({ cwd, home }, "absent")).toBe(false);
    expect(unregisterProject({ cwd, home }, "alpha")).toBe(true);
    expect(unregisterProject({ cwd, home }, "alpha")).toBe(false);
    expect(listProjects({ cwd, home })).toEqual([]);
    expect(resolveProject({ cwd: root, home, config: alpha.configPath })).toEqual(alpha);
    registerProject({ cwd, home }, "alpha", alpha.configPath);
    expect(resolveProject({ cwd, home, project: "alpha" })).toEqual(alpha);
  });

  test("недоступную регистрацию можно перечислить и удалить без восстановления её данных", () => {
    const workspace = initializeWorkspace({ cwd, home });
    const missing = join(root, "missing", ".relay", "config.json");
    writeConfig(workspace.configPath, {
      version: 1,
      projects: [{ name: "broken", configPath: relative(cwd, missing) }],
    });
    expect(listProjects({ cwd, home })).toEqual([{ name: "broken", configPath: missing }]);
    expect(errorCode(() => resolveProject({ cwd, home, project: "broken" }))).toBe(
      "CONFIG_NOT_FOUND",
    );
    expect(unregisterProject({ cwd, home }, "broken")).toBe(true);
    expect(existsSync(join(root, "missing"))).toBe(false);
  });

  test("повтор init workspace и ошибочная регистрация не изменяют список", () => {
    const workspace = initializeWorkspace({ cwd, home, config: "custom/workspace.json" });
    const options = { cwd, home, config: workspace.configPath };
    expect(errorCode(() => initializeWorkspace(options))).toBe("CONFIG_EXISTS");
    expect(errorCode(() => registerProject(options, "missing", "missing"))).toBe(
      "CONFIG_NOT_FOUND",
    );
    expect(errorCode(() => registerProject(options, "workspace", workspace.configPath))).toBe(
      "INVALID_CONFIG",
    );
    expect(errorCode(() => registerProject(options, " ", "missing"))).toBe("INVALID_ARGUMENT");
    expect(listProjects(options)).toEqual([]);
    expect(readdirSync(dirname(workspace.configPath))).toEqual(["workspace.json"]);
    expect(existsSync(home)).toBe(false);
  });

  test("диагностирует неправильную схему workspace и ссылку на workspace вместо проекта", () => {
    const workspace = initializeWorkspace({ cwd, home });
    writeConfig(workspace.configPath, {
      version: 1,
      projects: [
        { name: "same", configPath: "a" },
        { name: "same", configPath: "b" },
      ],
    });
    expect(errorCode(() => listProjects({ cwd, home }))).toBe("INVALID_CONFIG");
    writeConfig(workspace.configPath, {
      version: 1,
      projects: [{ name: "loop", configPath: workspace.configPath }],
    });
    expect(errorCode(() => resolveProject({ cwd, home, project: "loop" }))).toBe("INVALID_CONFIG");
    const project = initializeProject({ cwd: join(root, "project"), home });
    expect(errorCode(() => listProjects({ cwd, home, config: project.configPath }))).toBe(
      "WORKSPACE_REQUIRED",
    );
  });

  test("конкурентные процессы сохраняют все регистрации, читатели получают целый JSON", async () => {
    const workspace = initializeWorkspace({ cwd, home });
    const project = initializeProject({ cwd: join(root, "project"), home });
    const alias = join(root, "workspace-link.json");
    symlinkSync(workspace.configPath, alias);
    const workerPath = join(import.meta.dir, "registration-worker.ts");
    const count = 12;
    let ready = 0;
    let workers: ReturnType<typeof launch>[] = [];
    function launch(prefix: string, config: string, action: "register" | "unregister" | "read") {
      let markReady!: () => void;
      const started = new Promise<void>((resolve) => {
        markReady = resolve;
      });
      const child = Bun.spawn({
        cmd: [
          process.execPath,
          workerPath,
          JSON.stringify({ cwd, home, config, target: project.configPath, prefix, count, action }),
        ],
        cwd: root,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
        ipc(message: unknown) {
          if (typeof message !== "object" || message === null || !("ready" in message)) return;
          markReady();
          if (action === "read") return;
          ready++;
          if (ready === 2) {
            ready = 0;
            for (const worker of workers) worker.child.send("go");
          }
        },
      });
      children.push(child);
      return {
        child,
        started,
        result: Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]),
      };
    }

    const reader = launch("reader", workspace.configPath, "read");
    await reader.started;
    reader.child.send("go");
    workers = [
      launch("alpha", workspace.configPath, "register"),
      launch("beta", alias, "register"),
    ];
    for (const [exit, stdout, stderr] of await Promise.all(
      workers.map((worker) => worker.result),
    )) {
      expect({ exit, stdout, stderr }).toEqual({ exit: 0, stdout: "", stderr: "" });
    }
    const names = listProjects({ cwd, home })
      .map((entry) => entry.name)
      .sort();
    expect(names).toEqual(
      Array.from({ length: count }, (_, index) => [`alpha-${index}`, `beta-${index}`])
        .flat()
        .sort(),
    );

    // Теперь удаление и добавление конкурируют за тот же read-modify-write.
    workers = [
      launch("alpha", workspace.configPath, "unregister"),
      launch("gamma", alias, "register"),
    ];
    for (const [exit, stdout, stderr] of await Promise.all(
      workers.map((worker) => worker.result),
    )) {
      expect({ exit, stdout, stderr }).toEqual({ exit: 0, stdout: "", stderr: "" });
    }
    reader.child.send("stop");
    expect(await reader.result).toEqual([0, "", ""]);
    expect(
      listProjects({ cwd, home })
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(
      Array.from({ length: count }, (_, index) => [`beta-${index}`, `gamma-${index}`])
        .flat()
        .sort(),
    );
    expect(readdirSync(cwd).sort()).toEqual([
      "relay.workspace.json",
      "relay.workspace.json.lock.sqlite",
    ]);
    expect(resolveProject({ cwd: root, home, config: project.configPath })).toEqual(project);
  }, 20_000);
});
