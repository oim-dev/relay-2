import { join } from "node:path";
import {
  artifacts,
  componentTasks,
  componentTestTasks,
  readComponents,
  repository,
  repositoryTasks,
  requiredArtifacts,
} from "./catalog";
import { verifyCiWorkflow } from "./ci-model";
import type { Component } from "./verification.types";
import { verificationMessages } from "./verification.messages";

/**
 * Проверяет форму quality-команд и явные вызовы вложенного dispatcher в build.
 * Typecheck разрешает несколько собственных tsconfig, но только с --noEmit;
 * проверка по запрещённому фрагменту не отличала прямую компиляцию от проверки типов.
 */
function verifyLeafCommands(component: Component): void {
  for (const task of componentTasks) {
    const command = component.scripts[task];
    if (command === undefined) {
      continue;
    }
    if (task === "lint" && command !== "bun --bun oxlint --deny-warnings .") {
      throw new Error(verificationMessages.lintCommand(component.id));
    }
    if (
      task === "typecheck" &&
      !command
        .split(" && ")
        .every((step) => /^(?:bun --bun )?tsc --noEmit(?: -p [A-Za-z0-9_./-]+\.json)?$/u.test(step))
    ) {
      throw new Error(verificationMessages.typecheckCommand(component.id));
    }
    if (
      task === "build" &&
      (/\b(?:turbo|bun(?:\s+--[A-Za-z0-9=-]+)*\s+run)\b/u.test(command) ||
        command.includes("--pass-with-no-tests"))
    ) {
      throw new Error(verificationMessages.nonLeafCommand(component.id, task));
    }
  }
}

/**
 * Проверяет наличие scripts у реально существующих наборов и запрещает скрытые сборки/чужие тесты.
 * Пустой набор не создаёт зелёный CI job; manual native/extended профили остаются отдельными.
 */
export async function verifyComponents(
  components: readonly Component[],
  root = repository,
): Promise<void> {
  for (const component of components) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(component.id)) {
      throw new Error(verificationMessages.invalidComponent(component.id));
    }
    for (const name of Object.keys(component.scripts)) {
      if (
        name.startsWith("test:") &&
        !componentTasks.some((task) => task === name) &&
        !["test:native-service", "test:extended-replication"].includes(name)
      ) {
        throw new Error(verificationMessages.unplannedSuite(component.id, name));
      }
    }
    if (component.scripts.typecheck && !component.scripts.lint) {
      throw new Error(verificationMessages.missingLint(component.id));
    }
    for (const task of componentTestTasks) {
      const kind = task.slice("test:".length);
      const files = Array.from(
        new Bun.Glob(`**/*.${kind}.test.ts`).scanSync({ cwd: join(root, component.directory) }),
      ).filter((file) => !file.includes("node_modules") && !file.includes("dist/"));
      const command = component.scripts[task];
      if (files.length > 0 !== (command !== undefined)) {
        throw new Error(verificationMessages.suiteScriptMismatch(component.id, kind));
      }
      const expectedCommand = `bun test${kind === "e2e" ? " --no-orphans" : ""} .${kind}.test.ts`;
      if (command !== undefined && command !== expectedCommand) {
        throw new Error(verificationMessages.suiteCommand(component.id, kind, expectedCommand));
      }
    }
    verifyLeafCommands(component);
    if (
      component.scripts.build &&
      !artifacts.some((artifact) => artifact.component === component.id)
    ) {
      throw new Error(verificationMessages.missingBuildArtifact(component.id));
    }
  }
}

/**
 * Сверяет prerequisites Turbo с потребителями CI. Проверки не должны зависеть от чужих
 * unit/typecheck: только необходимые build-артефакты задают порядок графа.
 */
export async function verifyTaskDependencies(
  components: readonly Component[],
  root = repository,
): Promise<void> {
  const configuration: unknown = await Bun.file(join(root, "turbo.json")).json();
  if (
    !configuration ||
    typeof configuration !== "object" ||
    !("tasks" in configuration) ||
    !configuration.tasks ||
    typeof configuration.tasks !== "object"
  ) {
    throw new Error(verificationMessages.missingTurboTasks);
  }
  const tasks = new Map(Object.entries(configuration.tasks));
  const declared = [
    ...components.flatMap((component) =>
      componentTasks
        .filter((task) => component.scripts[task])
        .map((task) => ({ component: component.id, id: `${component.name}#${task}`, task })),
    ),
    ...repositoryTasks.map((task) => ({ component: "repository", id: `//#${task}`, task })),
  ];
  for (const item of declared) {
    const definition = tasks.get(item.id) ?? tasks.get(item.task);
    if (!definition || typeof definition !== "object") {
      throw new Error(verificationMessages.missingTurboTask(item.id));
    }
    const dependencies: unknown = "dependsOn" in definition ? definition.dependsOn : [];
    if (!Array.isArray(dependencies) || !dependencies.every((entry) => typeof entry === "string")) {
      throw new Error(verificationMessages.invalidDependencies(item.id));
    }
    const expected = requiredArtifacts(item.component, item.task).map((id) => {
      const artifact = artifacts.find((entry) => entry.id === id);
      const producer = components.find((entry) => entry.id === artifact?.component);
      if (!producer) {
        throw new Error(verificationMessages.missingProducer(id));
      }
      return `${producer.name}#build`;
    });
    const actual = dependencies.map((dependency) =>
      dependency === "build" ? item.id.replace(/#[^#]+$/u, "#build") : dependency,
    );
    // Server build уже ждёт Web, поэтому process может получать Web через этот producer.
    const covered = new Set(actual);
    for (const dependency of actual) {
      const producer = tasks.get(dependency);
      if (
        producer &&
        typeof producer === "object" &&
        "dependsOn" in producer &&
        Array.isArray(producer.dependsOn)
      ) {
        for (const transitive of producer.dependsOn) {
          covered.add(String(transitive));
        }
      }
    }
    if (
      actual.some((dependency) => !expected.includes(dependency)) ||
      expected.some((dependency) => !covered.has(dependency))
    ) {
      throw new Error(verificationMessages.dependencyDrift(item.id, expected, actual));
    }
  }
}

/**
 * Собирает shell-шаги декларативного workflow, сохраняя порядок и количество вызовов.
 */
function workflowCommands(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap(workflowCommands);
  }
  if (value === null || typeof value !== "object") {
    return [];
  }
  return Object.entries(value).flatMap(([key, entry]) =>
    key === "run" && typeof entry === "string" ? [entry] : workflowCommands(entry),
  );
}

/**
 * Проверяет объект декларации без утверждения типов неизвестного YAML.
 */
function workflowRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Отвергает отключение или подавление ошибки обязательной части проверки.
 */
function requireMandatoryExecution(value: Record<string, unknown>, condition?: string): void {
  if (
    value.if !== condition ||
    (value["continue-on-error"] !== undefined && value["continue-on-error"] !== false)
  ) {
    throw new Error(verificationMessages.mandatoryExecution);
  }
}

/**
 * Проверяет bindings и условия одного шага, а не только присутствие строки shell в workflow.
 */
function requireRunnerStep(
  steps: readonly unknown[],
  field: "id" | "name",
  name: string,
  bindings: Readonly<Record<string, string>>,
  condition?: string,
): void {
  const matches = steps.filter((step) => workflowRecord(step) && step[field] === name);
  const step = matches[0];
  if (matches.length !== 1 || !workflowRecord(step) || !workflowRecord(step.env)) {
    throw new Error(verificationMessages.ambiguousStep(name));
  }
  requireMandatoryExecution(step, condition);
  for (const [key, expected] of Object.entries(bindings)) {
    if (step.env[key] !== expected) {
      throw new Error(verificationMessages.changedBinding(name, key));
    }
  }
}

/**
 * Проверяет единственный исполняющий job и семантику его командных параметров.
 */
function requireWorkflowExecution(name: string, workflow: unknown): void {
  const jobNames: Readonly<Record<string, string>> = {
    "task.yml": "execute",
    "quality.yml": "quality",
    "native-services.yml": "native",
  };
  const jobId = jobNames[name];
  if (
    !jobId ||
    !workflowRecord(workflow) ||
    !workflowRecord(workflow.jobs) ||
    Object.keys(workflow.jobs).length !== 1
  ) {
    throw new Error(verificationMessages.singleJob(name));
  }
  const job = workflow.jobs[jobId];
  if (!workflowRecord(job) || !Array.isArray(job.steps) || job.strategy !== undefined) {
    throw new Error(verificationMessages.workflowMultiplicity(name));
  }
  requireMandatoryExecution(job);
  const component = "${{ inputs.component }}";
  if (name === "task.yml") {
    requireRunnerStep(job.steps, "id", "task", {
      COMPONENT: component,
      TASK: "${{ inputs.task }}",
      TARGET: "${{ inputs.target }}",
    });
  } else if (name === "quality.yml") {
    requireRunnerStep(job.steps, "name", "Lint", {
      COMPONENT: component,
      TASK: "${{ inputs.component == 'repository' && 'lint:repo' || 'lint' }}",
    });
    requireRunnerStep(
      job.steps,
      "name",
      "Types",
      {
        COMPONENT: component,
        TASK: "${{ inputs.component == 'repository' && 'typecheck:repo' || 'typecheck' }}",
      },
      "${{ !cancelled() && steps.setup.outcome == 'success' && steps.restore.outcome == 'success' }}",
    );
  } else {
    requireRunnerStep(job.steps, "name", "Проверить настоящий manager и lifecycle службы", {
      TARGET: "${{ inputs.target }}",
      CI: "true",
      RELAY_NATIVE_SERVICE_TESTS: "disposable-runner",
    });
  }
}

/**
 * Не позволяет reusable workflow добавить собственный тестовый shell-путь в обход leaf dispatcher.
 * Перенос и публикация CI-артефактов отделены от команд проверки.
 */
export async function verifyWorkflowEntrypoints(root = repository): Promise<void> {
  const expected = {
    "task.yml": [
      'bun run ci:task "$COMPONENT" "$TASK" "$TARGET"',
      'bun scripts/ci/artifacts.ts pack "$COMPONENT" "$TARGET" "$DIRECTORY"',
    ],
    "quality.yml": [
      'bun run ci:task "$COMPONENT" "$TASK" linux-x64',
      'bun run ci:task "$COMPONENT" "$TASK" linux-x64',
    ],
    "native-services.yml": ['bun run ci:task project-runtime test:native-service "$TARGET"'],
  };
  for (const [name, commands] of Object.entries(expected)) {
    const workflow: unknown = Bun.YAML.parse(
      await Bun.file(join(root, ".github/workflows", name)).text(),
    );
    if (
      JSON.stringify(workflowCommands(workflow).map((command) => command.trim())) !==
      JSON.stringify(commands)
    ) {
      throw new Error(verificationMessages.workflowCommands(name));
    }
    requireWorkflowExecution(name, workflow);
  }
}

/**
 * Проверяет полноту и единство плана локально, не создавая отчётов или workflows.
 */
export async function verifyConfiguration(): Promise<void> {
  const components = await readComponents();
  await verifyComponents(components);
  await verifyTaskDependencies(components);
  await verifyCiWorkflow(components);
  await verifyWorkflowEntrypoints();
  console.log(verificationMessages.aligned);
}

if (import.meta.main) {
  await verifyConfiguration();
}
