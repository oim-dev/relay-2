import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import type { NonSharedBuffer } from "node:buffer";
import { basename, dirname, join } from "node:path";
import {
  initializeProject,
  initializeWorkspace,
  listProjects,
  registerProject,
} from "@relay/project-runtime";
import { RuntimeFixture } from "./helpers/runtime-fixture";

/**
 * Воспроизводит окно Linux realpath Bun: inode заменён между open и чтением /proc/self/fd.
 * Настоящий rename сохраняет опубликованное имя; подмена касается только момента разрешения пути.
 */
function withReplacedConfigInode(path: string, operation: () => void): void {
  const realpath = fs.realpathSync;
  const originalNative = Object.getOwnPropertyDescriptor(realpath, "native");
  const expectedPath = Buffer.from(path);
  let replacements = 0;
  /**
   * Сохраняет кодировки realpath и воспроизводит смену inode только для проверяемого конфига.
   */
  const resolveDuringReplacement = (
    input: fs.PathLike,
    options?: fs.EncodingOption | fs.BufferEncodingOption,
  ): string | NonSharedBuffer => {
    const encoding = typeof options === "object" && options !== null ? options.encoding : options;
    let physical = realpath(input, "buffer");
    if (physical.equals(expectedPath)) {
      const descriptor = fs.openSync(path, "r");
      const temporary = `${path}.replacement`;
      try {
        fs.writeFileSync(temporary, fs.readFileSync(path));
        fs.renameSync(temporary, path);
        replacements++;
        physical = fs.readlinkSync(`/proc/self/fd/${descriptor}`, "buffer");
      } finally {
        fs.closeSync(descriptor);
        fs.rmSync(temporary, { force: true });
      }
    }
    return encoding === "buffer" ? physical : physical.toString(encoding ?? "utf8");
  };
  // Декоратор объединяет перегрузки fs; кодировка применяется после одной и той же инъекции.
  const resolver = spyOn(fs, "realpathSync").mockImplementation(
    Object.assign(resolveDuringReplacement, {
      native: resolveDuringReplacement,
    }) as typeof fs.realpathSync,
  );
  // mockImplementation переносит поведение вызова, но не свойства callback на сам spy.
  Object.defineProperty(resolver, "native", {
    value: resolveDuringReplacement,
    writable: true,
    configurable: true,
  });
  try {
    operation();
    expect(replacements).toBeGreaterThan(0);
  } finally {
    resolver.mockRestore();
    if (originalNative !== undefined) {
      Object.defineProperty(realpath, "native", originalNative);
    }
  }
}

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
