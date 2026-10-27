import { join, resolve } from "node:path";
import { artifacts, targets } from "../verification/catalog";
import type { BuildArtifact } from "../verification/verification.types";
import { ArtifactError } from "./artifacts-error";
import { artifactMessages } from "./artifacts.messages";
import type { ArtifactContext, ArtifactManifest } from "./artifacts.types";

/**
 * Читает закреплённые версии и проверяет реально запущенные Bun/Node до передачи данных.
 * Не выполняет сборку, установку зависимостей или запись отчёта.
 */
export async function readArtifactContext(root: string, sha: string): Promise<ArtifactContext> {
  if (!/^[a-f0-9]{40}$/u.test(sha)) {
    throw new ArtifactError("ARTIFACT_INPUT", artifactMessages.sha);
  }
  const bun = (await Bun.file(join(root, ".bun-version")).text()).trim();
  const node = (await Bun.file(join(root, ".node-version")).text()).trim();
  const actualNode = Bun.spawnSync(["node", "--version"], { stdout: "pipe", stderr: "pipe" });
  if (
    !/^\d+\.\d+\.\d+$/u.test(bun) ||
    !/^\d+\.\d+\.\d+$/u.test(node) ||
    Bun.version !== bun ||
    actualNode.exitCode !== 0 ||
    actualNode.stdout.toString().trim() !== `v${node}`
  ) {
    throw new ArtifactError("ARTIFACT_TOOLCHAIN", artifactMessages.toolchain);
  }
  return { root: resolve(root), sha, toolchain: { bun, node } };
}

/**
 * Разрешает компонент-производитель, а не ID артефакта: rest-sdk производит sdk.
 */
export function artifactForComponent(component: string): BuildArtifact {
  const matches = artifacts.filter((entry) => entry.component === component);
  const artifact = matches[0];
  if (matches.length !== 1 || !artifact) {
    throw new ArtifactError("ARTIFACT_INPUT", artifactMessages.input(component));
  }
  return artifact;
}

/**
 * Проверяет target команды; portable допустим лишь для задач без нативных prerequisites.
 */
export function validateArtifactTarget(target: string): void {
  if (target !== "portable" && !targets.some((entry) => entry.id === target)) {
    throw new ArtifactError("ARTIFACT_INPUT", artifactMessages.input(target));
  }
}

/**
 * Возвращает target конкретного output; переносимый результат не размножается по ОС.
 */
export function artifactTarget(artifact: BuildArtifact, target: string): string {
  validateArtifactTarget(target);
  if (artifact.portable) {
    return "portable";
  }
  if (target === "portable") {
    throw new ArtifactError("ARTIFACT_INPUT", artifactMessages.input(target));
  }
  return target;
}

/**
 * Строит единое имя передачи для producer, consumer и release.
 */
export function artifactName(artifact: BuildArtifact, target: string, sha: string): string {
  return `${artifact.id}-${artifactTarget(artifact, target)}-${sha}`;
}

/**
 * Декодирует неизвестный JSON и сверяет все идентифицирующие поля до работы с архивом.
 * Возвращает только проверенный v1, не доверяет приведению типов или сохранённому directory.
 */
export function decodeArtifactManifest(
  value: unknown,
  artifact: BuildArtifact,
  target: string,
  context: ArtifactContext,
): ArtifactManifest {
  const expected = {
    version: 1,
    id: artifact.id,
    component: artifact.component,
    target: artifactTarget(artifact, target),
    sha: context.sha,
    bun: context.toolchain.bun,
    node: context.toolchain.node,
    directory: artifact.directory,
  } as const;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== Object.keys(expected).length + 1 ||
    Object.entries(expected).some(([key, entry]) => Reflect.get(value, key) !== entry) ||
    !("sha256" in value) ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.sha256)
  ) {
    throw new ArtifactError(
      "ARTIFACT_METADATA",
      artifactMessages.metadata(artifactName(artifact, target, context.sha)),
    );
  }
  return { ...expected, sha256: value.sha256 };
}
