import { appendFile } from "node:fs/promises";
import { repository } from "../verification/catalog";
import { readArtifactContext } from "./artifacts-metadata";
import { createReleaseApi, findReleaseRun, selectReleaseRunArtifacts } from "./release-api";
import { bundleRelease } from "./release-bundle";
import { checkReleaseVersions } from "./release-plan";
import { releaseMessages } from "./release.messages";

/**
 * Проверяет положительный GitHub ID до включения в URL API.
 */
function releaseRunId(value: string | undefined): number {
  const id = Number(value);
  if (!value || !/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(id)) {
    throw new Error(releaseMessages.run);
  }
  return id;
}

/**
 * Предоставляет read-only find/select для workflow и локальную упаковку уже проверенных данных.
 * Создание GitHub Release принадлежит отдельному шагу gh с contents:write, не этому helper.
 */
async function runReleaseCommand(args: readonly string[]): Promise<void> {
  const [action, first, second, third] = args;
  const owner = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const output = process.env.GITHUB_OUTPUT;
  if (!owner || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(owner) || !token || !output) {
    throw new Error(releaseMessages.environment);
  }
  const context = await readArtifactContext(repository, process.env.GITHUB_SHA ?? "");
  const source = { repository: owner, sha: context.sha };
  const api = createReleaseApi(token, process.env.GITHUB_API_URL ?? "https://api.github.com");
  if (action === "find" && first && args.length === 2) {
    await checkReleaseVersions(context.root, first);
    const runId = await findReleaseRun(source, api, Date.now());
    await appendFile(output, `run-id=${runId ?? ""}\n`);
    return;
  }
  if (action === "select" && first && args.length === 2) {
    const runId = releaseRunId(first);
    const ids = await selectReleaseRunArtifacts(
      source,
      runId,
      releaseRunId(process.env.GITHUB_RUN_ID),
      api,
      Date.now(),
    );
    await appendFile(output, `artifact-ids=${ids.join(",")}\n`);
    return;
  }
  if (action === "bundle" && first && second && third && args.length === 4) {
    const path = await bundleRelease(context, first, second, third);
    await appendFile(output, `release-path=${path}\n`);
    return;
  }
  throw new Error(releaseMessages.usage);
}

if (import.meta.main) {
  await runReleaseCommand(process.argv.slice(2));
}
