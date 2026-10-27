import {
  artifacts,
  buildArtifact,
  componentTestTasks,
  repository,
  requiredArtifacts,
  targets,
} from "./catalog";
import { ciMessages } from "../ci/ci.messages";
import { verificationMessages } from "./verification.messages";
import type { CiJob, CiTarget, Component } from "./verification.types";

/**
 * Создаёт стабильное имя job из зарегистрированных имён, не из произвольного shell-ввода.
 */
export function jobId(component: string, task: string, target = ""): string {
  return [component, task, target]
    .filter(Boolean)
    .join("_")
    .replaceAll(/[^a-zA-Z0-9_]/gu, "_");
}

/**
 * Назначает один build job каждому portable/native артефакту.
 */
export function artifactJob(id: string, target: string): string {
  const artifact = buildArtifact(id);
  return jobId(artifact.component, "build", artifact.portable ? "portable" : target);
}

/**
 * Связывает потребителя только с его producers, без общего барьера матрицы других ОС.
 */
function artifactNeeds(component: string, task: string, target: string): readonly string[] {
  return requiredArtifacts(component, task).map((id) => artifactJob(id, target));
}

/**
 * Объявляет один job исполнения одной и той же package-команды локального check и CI.
 */
function taskJob(component: string, task: string, target: CiTarget, portable = false): CiJob {
  const targetId = portable ? "portable" : target.id;
  const needs = artifactNeeds(component, task, targetId);
  return {
    name: ciMessages.componentName(component),
    ...(needs.length > 0 ? { needs } : {}),
    uses: "./.github/workflows/task.yml",
    with: {
      component,
      task,
      target: targetId,
      runner: target.runner,
      "artifact-key": task.replaceAll(":", "-"),
      "display-name": ciMessages.taskName(task, targetId),
    },
  };
}

/**
 * Создаёт все jobs из фактических package scripts. Никакие тесты не вызываются через чужой workspace.
 * Статические workflows генерируются из этого плана и сверяются обязательным локальным check.
 */
export function ciJobs(components: readonly Component[]): Readonly<Record<string, CiJob>> {
  const jobs: Record<string, CiJob> = {};
  const linux = targets.find((target) => target.id === "linux-x64");
  if (!linux) {
    throw new Error(verificationMessages.missingPortableRunner);
  }
  for (const component of components) {
    if (component.scripts.typecheck) {
      const needs = artifactNeeds(component.id, "typecheck", linux.id);
      jobs[jobId(component.id, "quality")] = {
        name: ciMessages.componentName(component.id),
        ...(needs.length > 0 ? { needs } : {}),
        uses: "./.github/workflows/quality.yml",
        with: { component: component.id },
      };
    }
    for (const task of componentTestTasks) {
      if (!component.scripts[task]) {
        continue;
      }
      for (const target of targets) {
        jobs[jobId(component.id, task, target.id)] = taskJob(component.id, task, target);
      }
    }
  }
  for (const artifact of artifacts) {
    for (const target of artifact.portable ? [linux] : targets) {
      jobs[artifactJob(artifact.id, target.id)] = taskJob(
        artifact.component,
        "build",
        target,
        artifact.portable,
      );
    }
  }
  for (const task of ["format:check", "verify:configuration", "test:unit:repo"]) {
    jobs[jobId("repository", task)] = taskJob("repository", task, linux);
  }
  jobs.repository_quality = {
    name: ciMessages.componentName("repository"),
    needs: [artifactJob("sdk", linux.id)],
    uses: "./.github/workflows/quality.yml",
    with: { component: "repository" },
  };
  for (const target of targets) {
    jobs[jobId("product", "e2e", target.id)] = taskJob("repository", "test:e2e:product", target);
    const runnerVariable = { linux: "LINUX", darwin: "MACOS", win32: "WINDOWS" }[target.platform];
    jobs[jobId("native_services", target.id)] = {
      name: ciMessages.nativeGroup,
      needs: artifactNeeds("project-runtime", "test:native-service", target.id),
      uses: "./.github/workflows/native-services.yml",
      with: {
        target: target.id,
        runner: `\${{ vars.RELAY_NATIVE_${runnerVariable}_RUNNER || '${target.runner}' }}`,
        "display-name": ciMessages.nativeName(target.id),
      },
    };
  }
  jobs.result = {
    name: ciMessages.resultJob,
    needs: Object.keys(jobs),
    if: "${{ always() }}",
    "runs-on": linux.runner,
    steps: [
      {
        name: ciMessages.resultStep,
        uses: "actions/github-script@v8",
        env: { RESULTS: "${{ toJSON(needs) }}" },
        with: {
          script: [
            "const jobs = Object.entries(JSON.parse(process.env.RESULTS));",
            `await core.summary.addTable([${JSON.stringify(ciMessages.resultColumns)}, ...jobs.map(([name, value]) => [name, value.result])]).write();`,
            "const failed = jobs.filter(([, value]) => value.result !== 'success');",
            `if (failed.length) core.setFailed(${JSON.stringify(ciMessages.failedJobs)}.replace('{jobs}', failed.map(([name]) => name).join(', ')));`,
          ].join("\n"),
        },
      },
    ],
  };
  return jobs;
}

/**
 * Возвращает главный workflow: PR не дублируется push-запуском той же feature-ветки.
 * workflow_call позволяет release проверить отсутствующую поставку ровно одним прогоном.
 */
export function ciWorkflow(components: readonly Component[]): Readonly<Record<string, unknown>> {
  return {
    name: ciMessages.workflowName,
    on: {
      pull_request: {},
      push: { branches: ["main"] },
      workflow_dispatch: {},
      workflow_call: {},
    },
    permissions: { contents: "read", actions: "read" },
    concurrency: {
      group:
        "relay-ci-${{ github.event_name }}-${{ github.event.pull_request.number || github.ref }}",
      "cancel-in-progress": true,
    },
    jobs: ciJobs(components),
  };
}

/**
 * Канонизирует декларативный YAML для сравнения модели независимо от порядка ключей форматтера.
 */
export function canonicalConfiguration(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalConfiguration).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalConfiguration(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/**
 * Проверяет соответствие обязательного CI актуальному каталогу; не перезаписывает workflow.
 */
export async function verifyCiWorkflow(
  components: readonly Component[],
  root = repository,
): Promise<void> {
  const actual: unknown = Bun.YAML.parse(await Bun.file(`${root}/.github/workflows/ci.yml`).text());
  if (canonicalConfiguration(actual) !== canonicalConfiguration(ciWorkflow(components))) {
    throw new Error(verificationMessages.ciDrift);
  }
}
