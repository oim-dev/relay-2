import { join } from "node:path";
import { buildArtifact, targets } from "../verification/catalog";
import type { BuildArtifact } from "../verification/verification.types";
import { artifactName } from "./artifacts-metadata";
import { releaseMessages } from "./release.messages";
import type { ReleaseArtifact, ReleaseRun, ReleaseVersion } from "./release.types";

/**
 * Определяет состав поставки; каталоги и target принадлежат общему каталогу проверок.
 */
export function releaseBuildArtifacts(): readonly BuildArtifact[] {
  return ["cli", "server", "git-sync"].map(buildArtifact);
}

/**
 * Перечисляет только бинарные bundles этого SHA, без SDK, Web и журналов CI.
 */
export function requiredReleaseNames(sha: string): readonly string[] {
  return targets.flatMap((target) =>
    releaseBuildArtifacts().map((artifact) => artifactName(artifact, target.id, sha)),
  );
}

/**
 * Отделяет успешный CI нужного коммита от latest run, другого workflow и незавершённых проверок.
 */
export function isSuccessfulReleaseCi(run: ReleaseRun, sha: string): boolean {
  return (
    run.sha === sha &&
    run.workflow === ".github/workflows/ci.yml" &&
    run.status === "completed" &&
    run.conclusion === "success"
  );
}

/**
 * Возвращает точные ID полного набора либо null: отсутствие/expiry означает необходимость CI.
 * Дубликаты одного имени отклоняются, чтобы загрузка не выбирала случайный run attempt.
 */
export function selectReleaseArtifacts(
  available: readonly ReleaseArtifact[],
  sha: string,
  now: number,
): readonly number[] | null {
  const selected: number[] = [];
  for (const name of requiredReleaseNames(sha)) {
    const matches = available.filter(
      (artifact) => artifact.name === name && !artifact.expired && artifact.expiresAt > now,
    );
    const artifact = matches[0];
    if (matches.length !== 1 || !artifact) {
      return null;
    }
    selected.push(artifact.id);
  }
  return selected;
}

/**
 * Проверяет SemVer с префиксом v, включая отсутствие ведущих нулей в числовых prerelease ID.
 */
function isReleaseTag(tag: string): boolean {
  const match =
    /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(
      tag,
    );
  if (!match) {
    return false;
  }
  const prerelease = match[1];
  return (
    prerelease === undefined ||
    prerelease
      .split(".")
      .every(
        (identifier) =>
          !/^\d+$/u.test(identifier) || identifier === "0" || !identifier.startsWith("0"),
      )
  );
}

/**
 * Проверяет точное совпадение SemVer тега, root и приложений до запуска CI или публикации.
 */
export function validateReleaseVersions(tag: string, versions: readonly ReleaseVersion[]): string {
  const version = tag.slice(1);
  if (!isReleaseTag(tag) || versions.length < 2) {
    throw new Error(releaseMessages.tag);
  }
  for (const entry of versions) {
    if (entry.version !== version) {
      throw new Error(releaseMessages.version(entry.path, tag));
    }
  }
  return version;
}

/**
 * Читает все app manifests данного checkout; отсутствующая/повреждённая версия не замалчивается.
 */
export async function checkReleaseVersions(root: string, tag: string): Promise<string> {
  const paths = ["package.json"];
  for await (const path of new Bun.Glob("apps/*/package.json").scan({ cwd: root })) {
    paths.push(path);
  }
  const versions: ReleaseVersion[] = [];
  for (const path of paths.sort()) {
    const manifest: unknown = await Bun.file(join(root, path)).json();
    if (
      manifest === null ||
      typeof manifest !== "object" ||
      !("version" in manifest) ||
      typeof manifest.version !== "string"
    ) {
      throw new Error(releaseMessages.version(path, tag));
    }
    versions.push({ path, version: manifest.version });
  }
  return validateReleaseVersions(tag, versions);
}
