import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { absoluteRemote } from "./git";

describe("Разрешение remote проекта", () => {
  test.each([
    "example.org:/srv/project.git",
    "git@[::1]:/srv/project.git",
    "ssh://git@example.org/project.git",
    "https://example.org/project.git",
  ])("сетевой адрес %s не становится локальным файлом", async (remote) => {
    const resolved = await absoluteRemote("/unused", remote);

    expect(resolved).toBe(remote);
  });

  test("относительный путь вычисляется от каталога проекта, а не от worktree", async () => {
    const root = resolve("project");

    const resolved = await absoluteRemote(root, "../remote.git");

    expect(resolved).toBe(resolve(root, "../remote.git"));
  });
});
