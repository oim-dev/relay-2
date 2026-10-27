import { lstat, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { targets } from "../verification/catalog";
import { artifactDigest, prepareArtifactWorkspace, runArtifactTar } from "./artifacts-archive";
import { extractArtifact, verifyArtifactBundle } from "./artifacts-transfer";
import type { ArtifactContext } from "./artifacts.types";
import { checkReleaseVersions, releaseBuildArtifacts } from "./release-plan";
import { releaseMessages } from "./release.messages";

/**
 * Готовит по одному tar.gz с тремя бинарниками на target и общий SHA256SUMS.
 * Не исполняет чужие бинарники и не собирает приложение. Все bundles проходят тот же
 * декодер metadata, hash и whitelist архива, что CI restore, но без ограничения host.
 * Output должен быть пустым; временный staging удаляется при любом исходе.
 */
export async function bundleRelease(
  context: ArtifactContext,
  tag: string,
  downloadsDirectory: string,
  outputDirectory: string,
): Promise<string> {
  const version = await checkReleaseVersions(context.root, tag);
  const downloads = await prepareArtifactWorkspace(context.root, downloadsDirectory);
  const output = await prepareArtifactWorkspace(context.root, outputDirectory);
  if ((await readdir(output)).length !== 0) {
    throw new Error(releaseMessages.output);
  }
  const staging = await mkdtemp(join(output, ".staging-"));
  const checksums: string[] = [];
  try {
    for (const target of targets) {
      const names: string[] = [];
      for (const artifact of releaseBuildArtifacts()) {
        const bundle = await verifyArtifactBundle(context, artifact, target.id, downloads);
        const extracted = join(staging, `${target.id}-${artifact.id}`);
        await extractArtifact(bundle, extracted);
        const basename = artifact.id === "cli" ? "relay" : `relay-${artifact.id}`;
        const name = target.platform === "win32" ? `${basename}.exe` : basename;
        const binary = join(extracted, artifact.directory, name);
        const stat = await lstat(binary);
        if (!stat.isFile() || (target.platform !== "win32" && (stat.mode & 0o111) === 0)) {
          throw new Error(releaseMessages.binary(binary));
        }
        const destination = join(staging, name);
        // Общий staging позволяет сохранить permissions через rename без второй копии binary.
        await rename(binary, destination);
        await rm(extracted, { recursive: true });
        names.push(name);
      }
      const filename = `relay-${version}-${target.id}.tar.gz`;
      const archive = join(output, filename);
      await runArtifactTar(["-czf", archive, "-C", staging, ...names]);
      checksums.push(`${await artifactDigest(archive)}  ${filename}`);
      for (const name of names) {
        await rm(join(staging, name));
      }
    }
    await writeFile(join(output, "SHA256SUMS"), `${checksums.join("\n")}\n`, { flag: "wx" });
    return output;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
