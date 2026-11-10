import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as files from "node:fs";
import { dirname, join } from "node:path";
import { RelayError } from "@relay/contracts";
import { ProjectDatabase, type ProjectMetadata } from "@relay/storage";
import {
  initializeProject,
  openProject,
  resolveProject,
  resolveProjectRestoration,
  restoreProject,
  resumeProjectRestoration,
} from "@relay/project-runtime";
import { RuntimeFixture, runtimeErrorCode, withProjectDatabase } from "./helpers/runtime-fixture";

const ignoreLinks = [
  { name: "symlink", symbolic: true },
  { name: "hardlink", symbolic: false },
] as const;
let fixture: RuntimeFixture;

/**
 * Создаёт минимальную SQLite для materializer и освобождает соединение до публикации Runtime.
 */
function materialize(path: string): void {
  ProjectDatabase.create(path, {
    id: "restored",
    name: "Память проекта",
    slug: "restored",
  }).close();
}

beforeEach(() => {
  fixture = new RuntimeFixture("home-storage/runtime-layout");
});

afterEach(async () => {
  await fixture.dispose();
});

describe("Локальная реплика в домашней области Relay", () => {
  test("перенос явного config сохраняет БД в прежнем home и не создаёт служебных файлов рядом", () => {
    const callerIgnore = join(fixture.cwd, ".gitignore");
    files.writeFileSync(callerIgnore, "/caller-only\n");
    const options = { cwd: fixture.cwd, home: fixture.home, config: "settings/project.json" };
    const project = initializeProject(options);
    const config = files.readFileSync(project.configPath);
    const moved = join(fixture.root, "moved");
    files.renameSync(join(fixture.cwd, "settings"), moved);

    const selected = resolveProject({
      cwd: fixture.root,
      config: join(moved, "project.json"),
      home: fixture.home,
    });

    expect(selected).toEqual({ ...project, configPath: join(moved, "project.json") });
    expect(selected.databasePath).toBe(
      join(fixture.home, "projects", project.projectId, "project.sqlite"),
    );
    expect(files.readFileSync(selected.configPath)).toEqual(config);
    expect(JSON.parse(config.toString())).toEqual({ version: 1, projectId: project.projectId });
    expect(files.readFileSync(callerIgnore, "utf8")).toBe("/caller-only\n");
    expect(files.readdirSync(moved)).toEqual(["project.json"]);
  });

  test("init сохраняет readonly .gitignore дословно без добавления правил", () => {
    const path = join(fixture.cwd, ".gitignore");
    const before = "# Моё правило\r\n/build";
    files.writeFileSync(path, before);
    files.chmodSync(path, 0o444);
    try {
      const project = initializeProject({ cwd: fixture.cwd, home: fixture.home });

      expect(resolveProject({ cwd: fixture.cwd, home: fixture.home })).toEqual(project);
      expect(files.readFileSync(path, "utf8")).toBe(before);
      expect(files.readdirSync(fixture.cwd).sort()).toEqual([".gitignore", "relay.config.json"]);
    } finally {
      files.chmodSync(path, 0o600);
    }
  });

  test("init через symlink каталога сохраняет config-алиас и выбирает БД по ID в home", () => {
    const alias = join(fixture.root, "alias");
    files.symlinkSync(fixture.cwd, alias, "junction");
    const options = {
      cwd: fixture.root,
      config: join(alias, "nested", "project.json"),
      home: fixture.home,
    };

    const project = initializeProject(options);

    expect(project.databasePath).toBe(
      join(fixture.home, "projects", project.projectId, "project.sqlite"),
    );
    expect(project.configPath).toBe(options.config);
    expect(resolveProject(options)).toEqual(project);
    expect(files.readdirSync(join(fixture.cwd, "nested"))).toEqual(["project.json"]);
  });

  test("отказ init убирает только staging и сохраняет поздний чужой файл в каталоге ID", () => {
    let foreign = "";
    let publicPath = "";
    const create = ProjectDatabase.create;
    /**
     * Создаёт настоящую SQLite и чужой файл вне private staging перед отказом materializer.
     */
    function createThenFail(path: string, metadata: ProjectMetadata): ProjectDatabase {
      create(path, metadata).close();
      const directory = dirname(dirname(path));
      foreign = join(directory, "unrelated.txt");
      publicPath = join(directory, "project.sqlite");
      files.writeFileSync(foreign, "Чужие данные");
      throw new Error("fixture: отказ после создания");
    }
    const hook = spyOn(ProjectDatabase, "create").mockImplementation(createThenFail);
    try {
      const code = runtimeErrorCode(() =>
        initializeProject({ cwd: fixture.cwd, home: fixture.home }),
      );

      expect(code).toBe("IO_ERROR");
      expect(files.readFileSync(foreign, "utf8")).toBe("Чужие данные");
      expect(files.readdirSync(dirname(foreign)).sort()).toEqual([
        ".restore.lock.sqlite",
        "unrelated.txt",
      ]);
      expect(files.existsSync(join(fixture.cwd, "relay.config.json"))).toBe(false);
      expect(files.existsSync(publicPath)).toBe(false);
    } finally {
      hook.mockRestore();
    }
  });

  test.each(ignoreLinks)(
    ".gitignore $name не препятствует init и не изменяет общий файл",
    ({ symbolic }) => {
      const outside = join(fixture.root, "shared-ignore");
      files.writeFileSync(outside, "/shared\n");
      if (symbolic) {
        files.symlinkSync(outside, join(fixture.cwd, ".gitignore"));
      } else {
        files.linkSync(outside, join(fixture.cwd, ".gitignore"));
      }

      const project = initializeProject({ cwd: fixture.cwd, home: fixture.home });

      expect(resolveProject({ cwd: fixture.cwd, home: fixture.home })).toEqual(project);
      expect(files.readFileSync(outside, "utf8")).toBe("/shared\n");
      expect(files.lstatSync(join(fixture.cwd, ".gitignore")).isSymbolicLink()).toBe(symbolic);
    },
  );

  test("symlink прежней .relay не используется и сохраняет чужие данные при init", () => {
    const foreign = join(fixture.root, "foreign");
    files.mkdirSync(foreign);
    files.writeFileSync(join(foreign, "data.txt"), "Не изменять");
    files.symlinkSync(foreign, join(fixture.cwd, ".relay"), "junction");

    const project = initializeProject({ cwd: fixture.cwd, home: fixture.home });

    expect(resolveProject({ cwd: fixture.cwd, home: fixture.home })).toEqual(project);
    expect(files.readdirSync(foreign)).toEqual(["data.txt"]);
    expect(files.readFileSync(join(foreign, "data.txt"), "utf8")).toBe("Не изменять");
    expect(files.lstatSync(join(fixture.cwd, ".relay")).isSymbolicLink()).toBe(true);
  });

  test("два worktree с одним ID открывают одну БД и видят принятую запись друг друга", () => {
    const options = { cwd: fixture.cwd, home: fixture.home };
    const project = initializeProject(options);
    const secondCwd = join(fixture.root, "second-worktree");
    files.mkdirSync(secondCwd);
    files.copyFileSync(project.configPath, join(secondCwd, "relay.config.json"));
    const receipt = {
      operationKey: "shared-write",
      requestJson: "{}",
      resultJson: '{"saved":true}',
    };

    const second = openProject({ cwd: secondCwd, home: fixture.home });
    try {
      second.database.insertBatchReceipt(receipt);
      expect(second.location.databasePath).toBe(project.databasePath);
    } finally {
      second.database.close();
    }

    withProjectDatabase(project, (database) => {
      expect(database.getBatchReceipt(receipt.operationKey)).toEqual(receipt);
    });
    expect(files.readdirSync(secondCwd)).toEqual(["relay.config.json"]);
    expect(files.readdirSync(join(fixture.home, "projects"))).toEqual([project.projectId]);
  });

  test("один ID в разных home получает независимые данные и replicaId без изменения config", () => {
    const first = restoreProject({ cwd: fixture.cwd, home: fixture.home }, "restored", materialize);
    const before = files.readFileSync(first.configPath);
    const secondHome = join(fixture.root, "another-home");

    const second = restoreProject({ cwd: fixture.cwd, home: secondHome }, "restored", (path) => {
      ProjectDatabase.create(path, {
        id: "restored",
        name: "Другая реплика",
        slug: "other",
      }).close();
    });

    expect(second.databasePath).toBe(join(secondHome, "projects", "restored", "project.sqlite"));
    expect(resolveProject({ cwd: fixture.cwd, home: fixture.home })).toEqual(first);
    expect(resolveProject({ cwd: fixture.cwd, home: secondHome })).toEqual(second);
    const firstState = withProjectDatabase(first, (database) => ({
      name: database.get("PROJECT")?.data.name,
      replicaId: database.getReplicationState().replicaId,
    }));
    const secondState = withProjectDatabase(second, (database) => ({
      name: database.get("PROJECT")?.data.name,
      replicaId: database.getReplicationState().replicaId,
    }));
    expect(firstState.name).toBe("Память проекта");
    expect(secondState.name).toBe("Другая реплика");
    expect(firstState.replicaId).not.toBe(secondState.replicaId);
    expect(files.readFileSync(first.configPath)).toEqual(before);
  });

  test("restore без config не выбирает путь SQLite до получения постоянного ID", () => {
    const options = { cwd: fixture.cwd, home: fixture.home, config: "settings/project.json" };

    const context = resolveProjectRestoration(options);

    expect(context).toEqual({
      configPath: join(fixture.cwd, "settings", "project.json"),
      projectId: null,
      databasePath: null,
    });
    expect(files.readdirSync(fixture.cwd)).toEqual([]);
    expect(files.existsSync(fixture.home)).toBe(false);
  });

  test("проигрыш config при init сохраняет позднюю запись и завершается resume без пересоздания проекта", () => {
    const configPath = join(fixture.cwd, "relay.config.json");
    const receipt = {
      operationKey: "late-init",
      requestJson: "{}",
      resultJson: '{"committed":true}',
    };
    let databasePath = "";
    let foreignConfig = "";
    let replicaId = "";
    const link = files.linkSync;
    // Config ещё не опубликован, но публичную БД уже мог открыть другой участник.
    const hook = spyOn(files, "linkSync").mockImplementation((source, target) => {
      if (target === configPath) {
        const pendingConfig = JSON.parse(files.readFileSync(source, "utf8"));
        databasePath = join(fixture.home, "projects", pendingConfig.projectId, "project.sqlite");
        const writer = ProjectDatabase.open(databasePath);
        try {
          writer.insertBatchReceipt(receipt);
          replicaId = writer.getReplicationState().replicaId;
          foreignConfig = JSON.stringify({ version: 1, projectId: writer.projectId });
        } finally {
          writer.close();
        }
        files.writeFileSync(configPath, foreignConfig, { flag: "wx" });
      }
      link(source, target);
    });
    try {
      expect(() => initializeProject({ cwd: fixture.cwd, home: fixture.home })).toThrow(
        expect.objectContaining({
          code: "RESTORE_RECOVERY_REQUIRED",
          details: expect.objectContaining({
            sourceError: expect.objectContaining({ code: "CONFIG_EXISTS" }),
          }),
        }),
      );
    } finally {
      hook.mockRestore();
    }
    expect(files.readFileSync(configPath, "utf8")).toBe(foreignConfig);

    const resumed = resumeProjectRestoration(
      { cwd: fixture.cwd, home: fixture.home },
      undefined,
      (path) => {
        expect(path).toBe(databasePath);
      },
    );

    expect(resumed.recovery).toBeNull();
    expect(files.readFileSync(configPath, "utf8")).toBe(foreignConfig);
    expect(resolveProject({ cwd: fixture.cwd, home: fixture.home })).toEqual(resumed.location);
    withProjectDatabase(resumed.location, (database) => {
      expect(database.getBatchReceipt(receipt.operationKey)).toEqual(receipt);
      expect(database.getReplicationState().replicaId).toBe(replicaId);
      expect(database.getReplicationOutbox()).toHaveLength(2);
    });
  });

  test("restore через symlink каталога продолжает отказ публикации config без новой БД", () => {
    const alias = join(fixture.root, "alias");
    files.symlinkSync(fixture.cwd, alias, "junction");
    const options = { cwd: fixture.root, config: join(alias, "project.json"), home: fixture.home };
    const link = files.linkSync;
    const hook = spyOn(files, "linkSync").mockImplementation((source, target) => {
      if (target === options.config) {
        throw new RelayError("IO_ERROR", "fixture: отказ публикации config", 4);
      }
      link(source, target);
    });
    try {
      expect(runtimeErrorCode(() => restoreProject(options, "restored", materialize))).toBe(
        "RESTORE_RECOVERY_REQUIRED",
      );
    } finally {
      hook.mockRestore();
    }
    const path = join(fixture.home, "projects", "restored", "project.sqlite");
    const publicationPath = join(dirname(path), ".restore-publication.json");
    expect(JSON.parse(files.readFileSync(publicationPath, "utf8"))).toMatchObject({
      projectId: "restored",
      configPath: options.config,
      databasePath: path,
    });
    expect(files.existsSync(options.config)).toBe(false);
    const preserved = withProjectDatabase(
      { projectId: "restored", databasePath: path, configPath: options.config },
      (database) => ({
        state: database.getReplicationState(),
        outbox: database.getReplicationOutbox(),
      }),
    );
    const validated: string[] = [];

    const result = resumeProjectRestoration(options, "restored", (databasePath) => {
      validated.push(databasePath);
    });

    expect(validated).toEqual([path]);
    expect(result.recovery).toBeNull();
    expect(result.location).toEqual({
      projectId: "restored",
      databasePath: path,
      configPath: options.config,
    });
    expect(files.realpathSync(result.location.configPath)).toBe(join(fixture.cwd, "project.json"));
    expect(resolveProject(options)).toEqual(result.location);
    expect(JSON.parse(files.readFileSync(result.location.configPath, "utf8"))).toEqual({
      version: 1,
      projectId: "restored",
    });
    expect(
      withProjectDatabase(result.location, (database) => ({
        state: database.getReplicationState(),
        outbox: database.getReplicationOutbox(),
      })),
    ).toEqual(preserved);
    expect(files.readdirSync(fixture.cwd)).toEqual(["project.json"]);
    expect(files.existsSync(publicationPath)).toBe(false);
  });

  test("resume через symlink существующего config сохраняет алиас и исходный JSON без databasePath", () => {
    const configPath = join(fixture.cwd, "project.json");
    const config = '{\n  "version": 1, "projectId": "restored"\n}\n';
    files.writeFileSync(configPath, config);
    const alias = join(fixture.root, "project-link.json");
    files.symlinkSync(configPath, alias);
    const options = { cwd: fixture.root, config: alias, home: fixture.home };
    const path = join(fixture.home, "projects", "restored", "project.sqlite");
    const open = ProjectDatabase.open;
    const hook = spyOn(ProjectDatabase, "open").mockImplementation((candidate) => {
      if (candidate === path) {
        throw new RelayError("STORAGE_BUSY", "fixture: public WAL busy", 4);
      }
      return open(candidate);
    });
    try {
      expect(runtimeErrorCode(() => restoreProject(options, "restored", materialize))).toBe(
        "RESTORE_RECOVERY_REQUIRED",
      );
    } finally {
      hook.mockRestore();
    }
    const validated: string[] = [];

    const result = resumeProjectRestoration(options, undefined, (candidate) => {
      validated.push(candidate);
    });

    expect(result.location).toEqual({
      projectId: "restored",
      configPath: alias,
      databasePath: path,
    });
    expect(result.recovery).toBeNull();
    expect(validated).toEqual([path]);
    expect(resolveProject(options)).toEqual(result.location);
    expect(files.readFileSync(configPath, "utf8")).toBe(config);
    expect(files.lstatSync(alias).isSymbolicLink()).toBe(true);
    expect(files.readlinkSync(alias)).toBe(configPath);
    expect(files.readdirSync(fixture.cwd)).toEqual(["project.json"]);
    expect(files.existsSync(join(fixture.root, ".relay"))).toBe(false);
  });
});
