import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildArtifact, repository, requiredArtifacts } from "../verification/catalog";
import {
  artifactDigest,
  prepareArtifactWorkspace,
  requireArtifactDirectory,
  runArtifactTar,
  validateArtifactArchive,
  validateArtifactTree,
} from "./artifacts-archive";
import { ArtifactError } from "./artifacts-error";
import {
  artifactForComponent,
  artifactName,
  artifactTarget,
  readArtifactContext,
  validateArtifactTarget,
} from "./artifacts-metadata";
import {
  artifactPublication,
  extractArtifact,
  publishArtifacts,
  verifyArtifactBundle,
} from "./artifacts-transfer";
import { artifactMessages } from "./artifacts.messages";
import type {
  ArtifactContext,
  ArtifactManifest,
  ArtifactPublication,
  PackedArtifact,
} from "./artifacts.types";
import { assertArtifactHost } from "./native/host";

/**
 * Упаковывает единственный output компонента в новый bundle под переданным CI-каталогом.
 * Не собирает недостающий output, не копирует node_modules, не заменяет существующий bundle.
 */
export async function packArtifact(
  context: ArtifactContext,
  component: string,
  target: string,
  directory: string,
): Promise<PackedArtifact> {
  const artifact = artifactForComponent(component);
  const identity = artifactTarget(artifact, target);
  if (!artifact.portable) {
    assertArtifactHost(identity);
  }
  await requireArtifactDirectory(context.root, artifact.directory);
  await validateArtifactTree(context.root, artifact.directory);
  const workspace = await prepareArtifactWorkspace(context.root, directory);
  const name = artifactName(artifact, identity, context.sha);
  const path = join(workspace, name);
  await mkdir(path);
  try {
    const archive = join(path, "payload.tar");
    await runArtifactTar([
      "--format=ustar",
      "-cf",
      archive,
      "-C",
      context.root,
      artifact.directory,
    ]);
    await validateArtifactArchive(archive, artifact.directory);
    const manifest: ArtifactManifest = {
      version: 1,
      id: artifact.id,
      component: artifact.component,
      target: identity,
      sha: context.sha,
      ...context.toolchain,
      directory: artifact.directory,
      sha256: await artifactDigest(archive),
    };
    await writeFile(join(path, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
    });
    return { name, path };
  } catch (cause) {
    await rm(path, { recursive: true, force: true });
    throw cause;
  }
}

/**
 * Восстанавливает только requiredArtifacts выбранной leaf-задачи, без каких-либо сборок.
 * Все metadata, hash и заголовки проверяются до изменения output. Staging удаляется после
 * успеха; при отказе публикации сохраняется для восстановления, включая резервные output.
 * Публикация single-writer и откат описаны в publishArtifacts.
 */
export async function restoreArtifacts(
  context: ArtifactContext,
  component: string,
  task: string,
  target: string,
  directory: string,
): Promise<void> {
  validateArtifactTarget(target);
  const required = requiredArtifacts(component, task).map(buildArtifact);
  for (const artifact of required) {
    if (!artifact.portable) {
      assertArtifactHost(artifactTarget(artifact, target));
    }
  }
  if (required.length === 0) {
    return;
  }
  const downloads = await prepareArtifactWorkspace(context.root, directory);
  const bundles = [];
  for (const artifact of required) {
    bundles.push(await verifyArtifactBundle(context, artifact, target, downloads));
  }
  const staging = await mkdtemp(join(downloads, "restore-"));
  let retainStaging = false;
  try {
    const publications: ArtifactPublication[] = [];
    for (const bundle of bundles) {
      const output = join(staging, bundle.artifact.id);
      await extractArtifact(bundle, output);
      publications.push(await artifactPublication(context, bundle, output));
    }
    retainStaging = true;
    await publishArtifacts(publications);
    retainStaging = false;
  } finally {
    if (!retainStaging) {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

/**
 * Адаптирует согласованный CLI CI: аргументы передаются без shell-вычислений и автосборок.
 */
async function runArtifactCommand(args: readonly string[]): Promise<void> {
  const [action, component, first, second, third] = args;
  if (!component || !first || !second || (action !== "pack" && action !== "restore")) {
    throw new ArtifactError("ARTIFACT_INPUT", artifactMessages.usage);
  }
  const context = await readArtifactContext(repository, process.env.GITHUB_SHA ?? "");
  if (action === "pack" && args.length === 4) {
    const output = process.env.GITHUB_OUTPUT;
    if (!output) {
      throw new ArtifactError("ARTIFACT_INPUT", artifactMessages.output);
    }
    const artifact = await packArtifact(context, component, first, second);
    await appendFile(output, `artifact-name=${artifact.name}\nartifact-path=${artifact.path}\n`);
    return;
  }
  if (action === "restore" && third && args.length === 5) {
    await restoreArtifacts(context, component, first, second, third);
    return;
  }
  throw new ArtifactError("ARTIFACT_INPUT", artifactMessages.usage);
}

if (import.meta.main) {
  await runArtifactCommand(process.argv.slice(2));
}
