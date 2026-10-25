import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  initializeProject,
  initializeWorkspace,
  listProjects,
  resolveProject,
} from "@relay/project-runtime";
import { RuntimeFixture, writeConfig } from "./helpers/runtime-fixture";
import {
  expectRegistrationEvent,
  runRegistrationRace,
  startInitializationWorker,
  startRegistrationWorker,
  startWorkspaceReader,
  stopWorkspaceReader,
} from "./helpers/runtime-workers";
import { readInitializationResult } from "./helpers/worker-protocol";

const INITIALIZATION_TEST_TIMEOUT_MS = 15_000;
const REGISTRATION_TEST_TIMEOUT_MS = 20_000;
const REGISTRATION_COUNT = 12;

/**
 * Формирует независимый ожидаемый набор имён двух участников гонки в порядке сравнения.
 */
function expectedRegistrationNames(firstPrefix: string, secondPrefix: string): string[] {
  return Array.from({ length: REGISTRATION_COUNT }, (_, index) => [
    `${firstPrefix}-${index}`,
    `${secondPrefix}-${index}`,
  ])
    .flat()
    .sort();
}

describe("Инициализация в отдельных процессах", () => {
  let fixture: RuntimeFixture;

  beforeEach(() => {
    fixture = new RuntimeFixture();
  });

  afterEach(async () => {
    await fixture.dispose();
  });

  test(
    "без home используется homedir/.relay, а RELAY_HOME остаётся ответственностью CLI",
    async () => {
      const { cwd, root } = fixture;
      const expectedHome = join(root, "user");
      const worker = await startInitializationWorker(
        fixture,
        { cwd, expectedHome },
        {
          ...process.env,
          HOME: expectedHome,
          USERPROFILE: expectedHome,
          RELAY_HOME: join(root, "ignored"),
        },
      );

      worker.child.send("go");
      const { exit, stdout, stderr } = await worker.result;

      expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
      const result = readInitializationResult(stdout);
      expect(result.kind).toBe("success");
      if (result.kind !== "success") {
        throw new Error("Процесс init не создал проект в изолированном домашнем каталоге");
      }
      expect(result.location.databasePath).toBe(
        join(expectedHome, ".relay", "projects", result.location.projectId, "project.sqlite"),
      );
      expect(existsSync(join(root, "ignored"))).toBe(false);
    },
    INITIALIZATION_TEST_TIMEOUT_MS,
  );

  test(
    "два одновременных init публикуют один проект и не оставляют лишнюю базу",
    async () => {
      const { cwd, home } = fixture;
      const workers = await Promise.all([
        startInitializationWorker(fixture, { cwd, home, synchronizePublication: true }),
        startInitializationWorker(fixture, { cwd, home, synchronizePublication: true }),
      ]);

      // Обе базы уже созданы: проигрыш обязан произойти при публикации, а не ранней проверке пути.
      expect(readdirSync(join(home, "projects"))).toHaveLength(2);
      expect(existsSync(join(cwd, "relay.config.json"))).toBe(false);
      for (const worker of workers) {
        worker.child.stdin.write("g");
        await worker.child.stdin.end();
      }
      const completed = await Promise.all(workers.map((worker) => worker.result));

      const results = completed.map(({ exit, stdout, stderr }) => {
        expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
        return readInitializationResult(stdout);
      });
      expect(results.filter((result) => result.kind === "failure")).toEqual([
        { kind: "failure", code: "CONFIG_EXISTS" },
      ]);
      const successes = results.filter((result) => result.kind === "success");
      expect(successes).toHaveLength(1);
      const winner = successes[0];
      if (winner === undefined) {
        throw new Error("Ни одна попытка init не создала проект");
      }
      const { location } = winner;
      expect(resolveProject({ cwd, home })).toEqual(location);
      expect(readdirSync(join(home, "projects"))).toEqual([location.projectId]);
      expect(readdirSync(cwd)).toEqual(["relay.config.json"]);
    },
    INITIALIZATION_TEST_TIMEOUT_MS,
  );
});

describe("Межпроцессное изменение workspace", () => {
  let fixture: RuntimeFixture;

  beforeEach(() => {
    fixture = new RuntimeFixture();
  });

  afterEach(async () => {
    await fixture.dispose();
  });

  test(
    "два писателя через разные symlink сохраняют все регистрации, читатель видит целый JSON",
    async () => {
      const { cwd, home, root } = fixture;
      const workspace = initializeWorkspace({ cwd, home });
      const project = initializeProject({ cwd: join(root, "project"), home });
      const alias = join(root, "workspace-link.json");
      symlinkSync(workspace.configPath, alias);
      const common = { cwd, home, target: dirname(project.configPath), count: REGISTRATION_COUNT };
      const reader = await startWorkspaceReader(fixture, {
        ...common,
        config: workspace.configPath,
        prefix: "reader",
        action: "read",
      });

      await runRegistrationRace(fixture, [
        { ...common, prefix: "alpha", config: workspace.configPath, action: "register" },
        { ...common, prefix: "beta", config: alias, action: "register" },
      ]);
      await stopWorkspaceReader(reader);

      const names = listProjects({ cwd, home })
        .map((entry) => entry.name)
        .sort();
      expect(names).toEqual(expectedRegistrationNames("alpha", "beta"));
      expect(readdirSync(cwd).sort()).toEqual([
        "relay.workspace.json",
        "relay.workspace.json.lock.sqlite",
      ]);
      expect(resolveProject({ cwd: root, home, config: project.configPath })).toEqual(project);
    },
    REGISTRATION_TEST_TIMEOUT_MS,
  );

  test(
    "конкурентные удаление и добавление сохраняют остальные регистрации и целый JSON",
    async () => {
      const { cwd, home, root } = fixture;
      const workspace = initializeWorkspace({ cwd, home });
      const project = initializeProject({ cwd: join(root, "project"), home });
      const alias = join(root, "workspace-link.json");
      symlinkSync(workspace.configPath, alias);
      writeConfig(workspace.configPath, {
        version: 1,
        projects: expectedRegistrationNames("alpha", "beta").map((name) => ({
          name,
          path: dirname(project.configPath),
        })),
      });
      const common = { cwd, home, target: dirname(project.configPath), count: REGISTRATION_COUNT };
      const reader = await startWorkspaceReader(fixture, {
        ...common,
        config: workspace.configPath,
        prefix: "reader",
        action: "read",
      });

      await runRegistrationRace(fixture, [
        { ...common, prefix: "alpha", config: workspace.configPath, action: "unregister" },
        { ...common, prefix: "gamma", config: alias, action: "register" },
      ]);
      await stopWorkspaceReader(reader);

      const names = listProjects({ cwd, home })
        .map((entry) => entry.name)
        .sort();
      expect(names).toEqual(expectedRegistrationNames("beta", "gamma"));
      expect(readdirSync(cwd).sort()).toEqual([
        "relay.workspace.json",
        "relay.workspace.json.lock.sqlite",
      ]);
      expect(resolveProject({ cwd: root, home, config: project.configPath })).toEqual(project);
    },
    REGISTRATION_TEST_TIMEOUT_MS,
  );

  test.each([0, 1])(
    "разрыв IPC после %i операций отклоняет неполного писателя и сохраняет только разрешённые изменения",
    async (completed) => {
      const { cwd, home, root } = fixture;
      const workspace = initializeWorkspace({ cwd, home });
      const project = initializeProject({ cwd: join(root, "project"), home });
      const target = dirname(project.configPath);
      const original = { version: 1, projects: [{ name: "beta", path: target }] };
      writeConfig(workspace.configPath, original);
      const before = readFileSync(workspace.configPath, "utf8");
      const worker = startRegistrationWorker(fixture, {
        cwd,
        home,
        config: workspace.configPath,
        target,
        prefix: "alpha",
        count: 2,
        action: "register",
      });
      await expectRegistrationEvent(worker, { phase: "ready", index: 0 });
      if (completed === 1) {
        worker.send({ kind: "go", index: 0 });
        await expectRegistrationEvent(worker, { phase: "started", index: 0 });
        await expectRegistrationEvent(worker, { phase: "completed", index: 0 });
        await expectRegistrationEvent(worker, { phase: "ready", index: 1 });
      }

      worker.child.disconnect();
      const result = await worker.result;

      expect(result.exit).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Координатор отключился до завершения протокола workspace");
      const after = readFileSync(workspace.configPath, "utf8");
      expect(JSON.parse(after)).toEqual({
        version: 1,
        projects:
          completed === 0
            ? original.projects
            : [...original.projects, { name: "alpha-0", path: target }],
      });
      if (completed === 0) {
        expect(after).toBe(before);
      }
      expect(resolveProject({ cwd: root, home, config: project.configPath })).toEqual(project);
    },
    REGISTRATION_TEST_TIMEOUT_MS,
  );

  test("разрыв IPC после finished до finish возвращает отказ и сохраняет завершённые регистрации", async () => {
    const { cwd, home, root } = fixture;
    const workspace = initializeWorkspace({ cwd, home });
    const project = initializeProject({ cwd: join(root, "project"), home });
    const target = dirname(project.configPath);
    writeConfig(workspace.configPath, { version: 1, projects: [{ name: "beta", path: target }] });
    const worker = startRegistrationWorker(fixture, {
      cwd,
      home,
      config: workspace.configPath,
      target,
      prefix: "alpha",
      count: 1,
      action: "register",
    });
    await expectRegistrationEvent(worker, { phase: "ready", index: 0 });
    worker.send({ kind: "go", index: 0 });
    await expectRegistrationEvent(worker, { phase: "started", index: 0 });
    await expectRegistrationEvent(worker, { phase: "completed", index: 0 });
    await expectRegistrationEvent(worker, { phase: "finished", count: 1 });
    const before = readFileSync(workspace.configPath, "utf8");

    worker.child.disconnect();
    const result = await worker.result;

    expect(result.exit).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Координатор отключился до завершения протокола workspace");
    const after = readFileSync(workspace.configPath, "utf8");
    expect(after).toBe(before);
    expect(JSON.parse(after)).toEqual({
      version: 1,
      projects: [
        { name: "beta", path: target },
        { name: "alpha-0", path: target },
      ],
    });
  });

  test("разрыв IPC останавливает непрерывного читателя с отказом и сохраняет исходный JSON", async () => {
    const { cwd, home } = fixture;
    const workspace = initializeWorkspace({ cwd, home });
    const before = readFileSync(workspace.configPath, "utf8");
    const reader = await startWorkspaceReader(fixture, {
      cwd,
      home,
      config: workspace.configPath,
      target: cwd,
      prefix: "reader",
      count: 1,
      action: "read",
    });

    reader.child.disconnect();
    const result = await reader.result;

    expect(result.exit).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Координатор отключился до завершения протокола workspace");
    expect(readFileSync(workspace.configPath, "utf8")).toBe(before);
  });

  test("повтор go не разрешает следующую мутацию и не перезаписывает сохранённые регистрации", async () => {
    const { cwd, home, root } = fixture;
    const workspace = initializeWorkspace({ cwd, home });
    const project = initializeProject({ cwd: join(root, "project"), home });
    const target = dirname(project.configPath);
    writeConfig(workspace.configPath, { version: 1, projects: [{ name: "beta", path: target }] });
    const worker = startRegistrationWorker(fixture, {
      cwd,
      home,
      config: workspace.configPath,
      target,
      prefix: "alpha",
      count: 2,
      action: "register",
    });
    await expectRegistrationEvent(worker, { phase: "ready", index: 0 });
    worker.send({ kind: "go", index: 0 });
    await expectRegistrationEvent(worker, { phase: "started", index: 0 });
    await expectRegistrationEvent(worker, { phase: "completed", index: 0 });
    await expectRegistrationEvent(worker, { phase: "ready", index: 1 });
    const before = readFileSync(workspace.configPath, "utf8");

    worker.send({ kind: "go", index: 0 });
    const result = await worker.result;

    expect(result.exit).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('ожидалось {"kind":"go","index":1}');
    expect(result.stderr).toContain('получено {"kind":"go","index":0}');
    expect(readFileSync(workspace.configPath, "utf8")).toBe(before);
    expect(listProjects({ cwd, home })).toEqual([
      { name: "beta", path: target },
      { name: "alpha-0", path: target },
    ]);
  });
});
