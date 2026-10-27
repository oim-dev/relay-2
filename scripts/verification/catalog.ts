import { join } from "node:path";
import type { BuildArtifact, CiTarget, Component } from "./verification.types";
import { verificationMessages } from "./verification.messages";

export const repository = join(import.meta.dir, "../..");

/* Один перечень обычных операций используется полным check и генерацией CI-матриц. */
export const componentTasks = [
  "lint",
  "typecheck",
  "test:unit",
  "test:integration",
  "build",
  "test:process",
  "test:e2e",
] as const;

/* Тестовые leaf-команды выводятся из общего списка; opt-in профили в него не входят. */
export const componentTestTasks: ReadonlyArray<(typeof componentTasks)[number]> =
  componentTasks.filter((task) => task.startsWith("test:"));

export const repositoryTasks = [
  "format:check",
  "lint:repo",
  "typecheck:repo",
  "verify:configuration",
  "test:unit:repo",
  "test:e2e:product",
] as const;

export const targets: readonly CiTarget[] = [
  { id: "linux-x64", runner: "ubuntu-24.04", platform: "linux", arch: "x64" },
  { id: "windows-x64", runner: "windows-2025", platform: "win32", arch: "x64" },
  { id: "macos-arm64", runner: "macos-15", platform: "darwin", arch: "arm64" },
];

export const artifacts: readonly BuildArtifact[] = [
  {
    id: "sdk",
    component: "rest-sdk",
    directory: "packages/rest-sdk/dist/generated",
    portable: true,
  },
  { id: "web", component: "web", directory: "apps/web/dist", portable: true },
  { id: "cli", component: "cli", directory: "apps/cli/dist", portable: false },
  { id: "server", component: "server", directory: "apps/server/dist", portable: false },
  { id: "git-sync", component: "git-sync", directory: "apps/git-sync/dist", portable: false },
];

/**
 * Читает workspace scripts без shell и без зависимости от текущего cwd.
 * Новый компонент с проверочными scripts автоматически попадает в общий check и CI-матрицы.
 */
export async function readComponents(root = repository): Promise<readonly Component[]> {
  const components: Component[] = [];
  for await (const path of new Bun.Glob("{apps,packages}/*/package.json").scan({ cwd: root })) {
    const directory = path.replaceAll("\\", "/").replace(/\/package\.json$/u, "");
    components.push(await readComponentManifest(root, directory, directory.split("/")[1] ?? ""));
  }
  if (new Set(components.map((component) => component.id)).size !== components.length) {
    throw new Error(verificationMessages.uniqueComponents);
  }
  return components.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Проверяет внешний JSON package.json перед использованием его команд в плане.
 */
export async function readComponentManifest(
  root: string,
  directory: string,
  id: string,
): Promise<Component> {
  const path = join(root, directory, "package.json");
  const manifest: unknown = await Bun.file(path).json();
  if (
    !manifest ||
    typeof manifest !== "object" ||
    !("name" in manifest) ||
    typeof manifest.name !== "string"
  ) {
    throw new Error(verificationMessages.missingWorkspaceName(path));
  }
  const scripts: Record<string, string> = {};
  if ("scripts" in manifest) {
    if (
      !manifest.scripts ||
      typeof manifest.scripts !== "object" ||
      Array.isArray(manifest.scripts)
    ) {
      throw new Error(verificationMessages.invalidScripts(path));
    }
    for (const [name, command] of Object.entries(manifest.scripts)) {
      if (typeof command !== "string") {
        throw new Error(verificationMessages.invalidCommand(manifest.name, name));
      }
      scripts[name] = command;
    }
  }
  return { id, name: manifest.name, directory, scripts };
}

/**
 * Объявляет артефакты, необходимые одной leaf-команде. CI только восстанавливает их;
 * локальный Turbo получает те же prerequisites через dependsOn.
 */
export function requiredArtifacts(component: string, task: string): readonly string[] {
  if (
    ["lint", "format:check", "lint:repo", "test:unit:repo", "verify:configuration"].includes(task)
  ) {
    return [];
  }
  if (task === "build") {
    if (component === "server") {
      return ["web"];
    }
    if (component === "web") {
      return ["sdk"];
    }
    return [];
  }
  if (task === "test:e2e:product") {
    return ["sdk", "cli", "server", "git-sync"];
  }
  if (task === "test:native-service") {
    return ["cli", "git-sync"];
  }
  if (task === "test:process" || task === "test:e2e") {
    return component === "server" ? ["sdk", "web", "server"] : [component];
  }
  if (["rest-sdk", "web", "server", "repository"].includes(component)) {
    return ["sdk"];
  }
  return [];
}

/**
 * Возвращает единственный зарегистрированный результат сборки; неизвестное имя — ошибка плана.
 */
export function buildArtifact(id: string): BuildArtifact {
  const artifact = artifacts.find((entry) => entry.id === id);
  if (!artifact) {
    throw new Error(verificationMessages.unknownArtifact(id));
  }
  return artifact;
}
