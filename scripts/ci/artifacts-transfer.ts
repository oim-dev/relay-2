import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BuildArtifact } from "../verification/verification.types";
import {
  artifactDigest,
  ensureArtifactDirectories,
  isMissingPath,
  requireArtifactPath,
  runArtifactTar,
  validateArtifactArchive,
} from "./artifacts-archive";
import { ArtifactError } from "./artifacts-error";
import { artifactName, decodeArtifactManifest } from "./artifacts-metadata";
import { artifactMessages } from "./artifacts.messages";
import type { ArtifactContext, ArtifactPublication, VerifiedArtifact } from "./artifacts.types";

/**
 * Проверяет один загруженный bundle без записи в output и без доверия к metadata.
 * Допускает чужой target для release как данные; host-guard принадлежит исполняющему consumer.
 */
export async function verifyArtifactBundle(
  context: ArtifactContext,
  artifact: BuildArtifact,
  target: string,
  downloads: string,
): Promise<VerifiedArtifact> {
  const name = artifactName(artifact, target, context.sha);
  const directory = join(downloads, name);
  const metadata = join(directory, "manifest.json");
  const archive = join(directory, "payload.tar");
  await requireArtifactPath(directory, "directory");
  await requireArtifactPath(metadata, "file");
  await requireArtifactPath(archive, "file");
  let input: unknown;
  try {
    input = await Bun.file(metadata).json();
  } catch (cause) {
    throw new ArtifactError("ARTIFACT_METADATA", artifactMessages.metadata(name), { cause });
  }
  const manifest = decodeArtifactManifest(input, artifact, target, context);
  if ((await artifactDigest(archive)) !== manifest.sha256) {
    throw new ArtifactError("ARTIFACT_HASH", artifactMessages.hash(name));
  }
  await validateArtifactArchive(archive, artifact.directory);
  return { artifact, archive };
}

/**
 * Распаковывает проверенный bundle только в пустой staging, сохраняя режимы файлов.
 * Владение staging и неизменность archive между проверкой и распаковкой остаются у CI job.
 */
export async function extractArtifact(bundle: VerifiedArtifact, staging: string): Promise<void> {
  await mkdir(staging);
  await runArtifactTar(["-xpf", bundle.archive, "--no-same-owner", "-C", staging]);
}

/**
 * Строит назначения из доверенного каталога и запрещает ссылки в их родительских путях.
 */
export async function artifactPublication(
  context: ArtifactContext,
  bundle: VerifiedArtifact,
  staging: string,
): Promise<ArtifactPublication> {
  const directory = bundle.artifact.directory;
  await ensureArtifactDirectories(context.root, dirname(directory).split("\\").join("/"));
  const destination = join(context.root, directory);
  try {
    const stat = await lstat(destination);
    if (!stat.isDirectory()) {
      throw new ArtifactError("ARTIFACT_UNSAFE_ARCHIVE", artifactMessages.destination(destination));
    }
  } catch (error) {
    if (!isMissingPath(error)) {
      throw error;
    }
  }
  return {
    destination,
    prepared: join(staging, directory),
    backup: join(staging, "previous-output"),
  };
}

/**
 * Заменяет подготовленные output целиком, не оставляя устаревших файлов.
 * При ошибке rename откатывает сделанные замены. Это CI single-writer, не транзакция
 * для конкурирующих процессов; аварийное завершение процесса не обещает crash-atomicity.
 */
export async function publishArtifacts(
  publications: readonly ArtifactPublication[],
): Promise<void> {
  const saved: ArtifactPublication[] = [];
  const published: ArtifactPublication[] = [];
  try {
    for (const entry of publications) {
      try {
        await rename(entry.destination, entry.backup);
        saved.push(entry);
      } catch (error) {
        if (!isMissingPath(error)) {
          throw error;
        }
      }
      await rename(entry.prepared, entry.destination);
      published.push(entry);
    }
  } catch (cause) {
    const rollbackErrors: unknown[] = [];
    for (const entry of published.toReversed()) {
      try {
        await rm(entry.destination, { recursive: true });
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    for (const entry of saved.toReversed()) {
      try {
        await rename(entry.backup, entry.destination);
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([cause, ...rollbackErrors], artifactMessages.rollback, { cause });
    }
    throw cause;
  }
}
