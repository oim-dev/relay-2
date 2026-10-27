import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  initializeProject,
  initializeWorkspace,
  listProjects,
  registerProject,
} from "@relay/project-runtime";
import { RuntimeFixture } from "./helpers/runtime-fixture";
import { withReplacedConfigInode } from "./helpers/native/linux/config-inode";

describe("Физический путь заменяемого workspace", () => {
  let fixture: RuntimeFixture;

  beforeEach(() => {
    fixture = new RuntimeFixture("workspace-path");
  });

  afterEach(async () => {
    await fixture.dispose();
  });

  if (process.platform === "linux") {
    test.each(["relay.workspace.json", "реестр (deleted)"])(
      "замена inode при разрешении %s не меняет путь публикации и mutex",
      (name) => {
        const { cwd, home, root } = fixture;
        const workspace = initializeWorkspace({ cwd, home, config: name });
        const project = initializeProject({ cwd: join(root, "project"), home });
        const target = dirname(project.configPath);
        registerProject({ cwd, home, config: name }, "existing", target);
        const alias = join(root, "workspace-link.json");
        fs.symlinkSync(workspace.configPath, alias);

        withReplacedConfigInode(workspace.configPath, () => {
          registerProject({ cwd: root, home, config: alias }, "added", target);
        });

        expect(listProjects({ cwd, home, config: name })).toEqual([
          { name: "existing", path: target },
          { name: "added", path: target },
        ]);
        expect(fs.readdirSync(cwd).sort()).toEqual([name, `${name}.lock.sqlite`].sort());
        expect(fs.readlinkSync(alias)).toBe(workspace.configPath);
      },
    );
  }

  test("относительная цепочка файловых и каталоговых symlink сохраняет физический реестр", () => {
    const { cwd, home, root } = fixture;
    const workspace = initializeWorkspace({ cwd, home });
    const project = initializeProject({ cwd: join(root, "project"), home });
    const directoryAlias = join(root, "workspace-directory");
    fs.symlinkSync(cwd, directoryAlias, "dir");
    const first = join(root, "workspace-first.json");
    const firstTarget = join(basename(directoryAlias), basename(workspace.configPath));
    fs.symlinkSync(firstTarget, first);
    const second = join(root, "workspace-second.json");
    fs.symlinkSync(basename(first), second);

    registerProject({ cwd: root, home, config: second }, "linked", dirname(project.configPath));

    expect(listProjects({ cwd, home })).toEqual([
      { name: "linked", path: dirname(project.configPath) },
    ]);
    expect(fs.readdirSync(cwd).sort()).toEqual([
      "relay.workspace.json",
      "relay.workspace.json.lock.sqlite",
    ]);
    expect(fs.lstatSync(directoryAlias).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(first)).toBe(firstTarget);
    expect(fs.readlinkSync(second)).toBe(basename(first));
  });

  // Windows нормализует такую цель иначе: fixture проверяет POSIX-порядок ссылки и родителя.
  test.skipIf(process.platform === "win32")(
    "POSIX-родитель в цели symlink разрешается после физического каталога ссылки",
    () => {
      const { home, root } = fixture;
      const workspace = initializeWorkspace({ cwd: join(root, "physical"), home });
      const child = join(dirname(workspace.configPath), "child");
      fs.mkdirSync(child);
      const directoryAlias = join(root, "directory-link");
      fs.symlinkSync(child, directoryAlias, "dir");
      const alias = join(root, "workspace-link.json");
      fs.symlinkSync("directory-link/../relay.workspace.json", alias);
      const project = initializeProject({ cwd: join(root, "project"), home });
      expect(fs.statSync(alias).ino).toBe(fs.statSync(workspace.configPath).ino);

      registerProject({ cwd: root, home, config: alias }, "linked", dirname(project.configPath));

      expect(listProjects({ cwd: dirname(workspace.configPath), home })).toEqual([
        { name: "linked", path: dirname(project.configPath) },
      ]);
      expect(fs.readdirSync(dirname(workspace.configPath)).sort()).toEqual([
        "child",
        "relay.workspace.json",
        "relay.workspace.json.lock.sqlite",
      ]);
    },
  );
});
