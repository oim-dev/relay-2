import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  initializeProject,
  initializeWorkspace,
  listProjects,
  registerProject,
} from "@relay/project-runtime";
import { RuntimeFixture } from "./helpers/runtime-fixture";
import { windowsShortFilePath } from "./helpers/native/windows/short-path";

if (process.platform === "win32") {
  const name = "workspace-with-long-file-name.json";
  // Отдельная проба очищается ещё до регистрации skip: пропущенный тест не владеет файлами.
  const probe = new RuntimeFixture("workspace-windows-path");
  let supported = false;
  try {
    const workspace = initializeWorkspace({ cwd: probe.cwd, home: probe.home, config: name });
    supported = windowsShortFilePath(workspace.configPath) !== null;
  } finally {
    await probe.dispose();
  }

  describe("Короткий файловый алиас workspace Windows", () => {
    let fixture: RuntimeFixture;
    beforeEach(() => {
      fixture = new RuntimeFixture("workspace-windows-path");
    });
    afterEach(async () => {
      await fixture.dispose();
    });

    test.skipIf(!supported)("длинное имя и алиас 8.3 используют один реестр и один mutex", () => {
      const { cwd, home, root } = fixture;
      const workspace = initializeWorkspace({ cwd, home, config: name });
      const project = initializeProject({ cwd: join(root, "project"), home });
      const target = dirname(project.configPath);
      registerProject({ cwd, home, config: name }, "existing", target);
      // Публикация заменяет inode, поэтому алиас читается после неё у текущего файла.
      const short = windowsShortFilePath(workspace.configPath);
      if (short === null) {
        throw new Error("Том перестал предоставлять короткое имя workspace");
      }
      expect(statSync(short, { bigint: true }).ino).toBe(
        statSync(workspace.configPath, { bigint: true }).ino,
      );

      registerProject({ cwd, home, config: short }, "added", target);

      expect(listProjects({ cwd, home, config: name })).toEqual([
        { name: "existing", path: target },
        { name: "added", path: target },
      ]);
      expect(readdirSync(cwd).sort()).toEqual([name, `${name}.lock.sqlite`].sort());
    });
  });
}
