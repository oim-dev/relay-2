import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { checkCommand } from "./check-command";
import {
  artifacts,
  readComponents,
  repository,
  repositoryTasks,
  requiredArtifacts,
} from "./catalog";
import { artifactJob, ciJobs, ciWorkflow, verifyCiWorkflow } from "./ci-model";
import {
  verifyComponents,
  verifyTaskDependencies,
  verifyWorkflowEntrypoints,
} from "./configuration";
import type { PlannedTask } from "./verification.test.types";

/**
 * Читает настоящий Turbo dry-run без исполнения тестов, сборок и записи отчётов.
 */
async function plannedTasks(): Promise<readonly PlannedTask[]> {
  const child = Bun.spawn([...checkCommand(4), "--dry-run=json"], {
    cwd: repository,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
  });
  const [code, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, error }).toMatchObject({ code: 0 });
  const value: unknown = JSON.parse(output);
  if (!value || typeof value !== "object" || !("tasks" in value) || !Array.isArray(value.tasks)) {
    throw new Error("Turbo не вернул список задач");
  }
  return value.tasks
    .map((item: unknown) => {
      if (
        !item ||
        typeof item !== "object" ||
        !("taskId" in item) ||
        typeof item.taskId !== "string" ||
        !("command" in item) ||
        typeof item.command !== "string" ||
        !("dependencies" in item) ||
        !Array.isArray(item.dependencies) ||
        !item.dependencies.every((entry: unknown) => typeof entry === "string") ||
        !("resolvedTaskDefinition" in item) ||
        !item.resolvedTaskDefinition ||
        typeof item.resolvedTaskDefinition !== "object" ||
        !("cache" in item.resolvedTaskDefinition) ||
        typeof item.resolvedTaskDefinition.cache !== "boolean"
      ) {
        throw new Error("Некорректная задача Turbo dry-run");
      }
      return {
        id: item.taskId,
        command: item.command,
        dependencies: item.dependencies,
        cache: item.resolvedTaskDefinition.cache,
      };
    })
    .filter((task) => task.command !== "<NONEXISTENT>");
}

describe("Единый граф check и CI", () => {
  test("реальный Turbo включает каждую обычную CI-команду один раз и кеширует только переносимые сборки", async () => {
    const components = await readComponents();
    const tasks = await plannedTasks();
    const ids = tasks.map((task) => task.id);
    const expected = new Set<string>();
    for (const job of Object.values(ciJobs(components))) {
      const componentId = job.with?.component;
      if (!componentId) {
        continue;
      }
      const component = components.find((entry) => entry.id === componentId);
      let selected: readonly string[];
      if (job.uses?.endsWith("quality.yml")) {
        selected =
          componentId === "repository" ? ["lint:repo", "typecheck:repo"] : ["lint", "typecheck"];
      } else {
        selected = job.with?.task ? [job.with.task] : [];
      }
      for (const task of selected) {
        expected.add(`${componentId === "repository" ? "//" : component?.name}#${task}`);
      }
    }

    expect(ids).toHaveLength(new Set(ids).size);
    expect([...ids].sort()).toEqual([...expected].sort());
    expect(ids).toContain("@relay/cli#test:e2e");
    expect(ids).toContain("//#test:e2e:product");
    expect(ids.some((id) => id.includes("native-service") || id.includes("extended"))).toBe(false);
    expect(
      tasks
        .filter((task) => task.cache)
        .map((task) => task.id)
        .sort(),
    ).toEqual(["@relay/rest-sdk#build", "@relay/web#build"]);
    expect(tasks.find((task) => task.id === "@relay/cli#build")?.dependencies).toEqual([]);
    expect(tasks.find((task) => task.id === "@relay/core#test:integration")?.dependencies).toEqual(
      [],
    );
    expect(tasks.find((task) => task.id === "@relay/cli#test:e2e")?.dependencies).toEqual([
      "@relay/cli#build",
    ]);
    expect(
      tasks.find((task) => task.id === "//#test:e2e:product")?.dependencies.toSorted(),
    ).toEqual([
      "@relay/cli#build",
      "@relay/git-sync#build",
      "@relay/rest-sdk#build",
      "@relay/server#build",
    ]);
    expect(tasks.find((task) => task.id === "@relay/server#build")?.dependencies).toEqual([
      "@relay/web#build",
    ]);
    expect(tasks.find((task) => task.id === "@relay/web#build")?.dependencies).toEqual([
      "@relay/rest-sdk#build",
    ]);
  });

  test("каждый набор компонента и продуктовый E2E исполняются ровно один раз на каждой поддержанной ОС", async () => {
    const components = await readComponents();

    const jobs = Object.values(ciJobs(components));

    // Set задач без target скрывает потерю одной ОС или дублирование её job.
    for (const component of components) {
      for (const task of ["test:unit", "test:integration", "test:process", "test:e2e"]) {
        if (!component.scripts[task]) {
          continue;
        }
        const matching = jobs.filter(
          (job) => job.with?.component === component.id && job.with.task === task,
        );
        expect(matching.map((job) => job.with?.target).sort(), `${component.id}/${task}`).toEqual([
          "linux-x64",
          "macos-arm64",
          "windows-x64",
        ]);
      }
    }
    const product = jobs.filter((job) => job.with?.task === "test:e2e:product");
    expect(product.map((job) => job.with?.target).sort()).toEqual([
      "linux-x64",
      "macos-arm64",
      "windows-x64",
    ]);
  });

  test("CI ждёт производителей только своего target и не строит их повторно в тестах", async () => {
    const components = await readComponents();
    const jobs = ciJobs(components);
    for (const [id, job] of Object.entries(jobs)) {
      const { component, task, target } = job.with ?? {};
      if (!component || !task || !target) {
        continue;
      }
      const needs = requiredArtifacts(component, task).map((artifact) =>
        artifactJob(artifact, target),
      );
      expect(job.needs ?? []).toEqual(needs);
      for (const prerequisite of needs) {
        expect(jobs[prerequisite]?.with?.task).toBe("build");
      }
      if (task === "build") {
        expect(id).toBe(
          artifactJob(
            artifacts.find((artifact) => artifact.component === component)?.id ?? "",
            target,
          ),
        );
      }
    }
    expect(jobs.cli_test_process_linux_x64?.needs).toEqual(["cli_build_linux_x64"]);
    expect(jobs.product_e2e_linux_x64?.needs).not.toContain("cli_build_windows_x64");
    expect(jobs.result?.needs?.length).toBe(Object.keys(jobs).length - 1);
  });

  test("workspaces, файлы наборов, YAML и зависимости Turbo согласованы", async () => {
    const components = await readComponents();
    await verifyComponents(components);
    await verifyTaskDependencies(components);
    await verifyCiWorkflow(components);
    await verifyWorkflowEntrypoints();
    expect(repositoryTasks).toContain("verify:configuration");
  });

  test("скрытая сборка в unit и потерянный script существующего набора отвергаются", async () => {
    const component = (await readComponents()).find((entry) => entry.id === "core");
    if (!component) {
      throw new Error("Отсутствует Core");
    }
    const { "test:unit": _unit, ...missing } = component.scripts;

    await expect(verifyComponents([{ ...component, scripts: missing }])).rejects.toThrow(
      "набор и package script",
    );
    await expect(
      verifyComponents([
        {
          ...component,
          scripts: { ...component.scripts, "test:unit": "bun run build && bun test .unit.test.ts" },
        },
      ]),
    ).rejects.toThrow("leaf-команда");
  });

  test("привязка Linux-проверки к Windows build обнаруживается локально до CI", async () => {
    const components = await readComponents();
    const jobs = ciJobs(components);
    const parent = join(
      repository,
      ".artifacts",
      new Date().toISOString().slice(0, 10),
      "ci-check",
    );
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "workflow-drift-"));
    try {
      const directory = join(root, ".github/workflows");
      await mkdir(directory, { recursive: true });
      await Bun.write(
        join(directory, "ci.yml"),
        Bun.YAML.stringify({
          ...ciWorkflow(components),
          jobs: {
            ...jobs,
            cli_test_process_linux_x64: {
              ...jobs.cli_test_process_linux_x64,
              needs: ["cli_build_windows_x64"],
            },
          },
        }),
      );

      await expect(verifyCiWorkflow(components, root)).rejects.toThrow("CI не соответствует");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
