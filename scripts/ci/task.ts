import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  artifacts,
  componentTasks,
  readComponentManifest,
  readComponents,
  repository,
  repositoryTasks,
  requiredArtifacts,
} from "../verification/catalog";
import { verifyEnvironment } from "../verification/environment";
import { requireHostTarget } from "./native/target";
import { ciMessages } from "./ci.messages";

/**
 * Выполняет одну объявленную leaf-команду. Все build dependencies уже должны быть получены;
 * отсутствие артефакта не запускает скрытую сборку. CI записывает только свой step summary.
 */
async function runTask(componentId: string, task: string, target: string): Promise<number> {
  requireHostTarget(target);
  const allowed =
    componentId === "repository"
      ? [...repositoryTasks]
      : [...componentTasks, "test:native-service"];
  if (!allowed.some((value) => value === task)) {
    throw new Error(ciMessages.unknownTask(task));
  }
  if (task === "test:native-service" && componentId !== "project-runtime") {
    throw new Error(ciMessages.nativeRuntimeOnly);
  }
  const component =
    componentId === "repository"
      ? await readComponentManifest(repository, ".", "repository")
      : (await readComponents()).find((entry) => entry.id === componentId);
  if (!component?.scripts[task]) {
    throw new Error(ciMessages.missingTask(componentId, task));
  }
  for (const id of requiredArtifacts(componentId, task)) {
    const artifact = artifacts.find((entry) => entry.id === id);
    if (!artifact || !existsSync(join(repository, artifact.directory))) {
      throw new Error(ciMessages.missingArtifact(id, componentId, task));
    }
  }
  await verifyEnvironment();
  const started = performance.now();
  console.log(ciMessages.taskStarted(componentId, task, target));
  const child = Bun.spawn(
    [process.execPath, "run", "--cwd", join(repository, component.directory), task],
    {
      cwd: repository,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const code = await child.exited;
  const seconds = ((performance.now() - started) / 1000).toFixed(2);
  console.log(ciMessages.taskFinished(componentId, task, code, seconds));
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      ciMessages.taskSummary(componentId, task, target, code, seconds),
    );
  }
  return code;
}

if (process.argv.length !== 5) {
  throw new Error(ciMessages.taskUsage);
}
const [component, task, target] = process.argv.slice(2);
if (!component || !task || !target) {
  throw new Error(ciMessages.taskArguments);
}
process.exitCode = await runTask(component, task, target);
