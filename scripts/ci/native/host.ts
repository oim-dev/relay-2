import { join } from "node:path";
import { ArtifactError } from "../artifacts-error";
import { artifactMessages } from "../artifacts.messages";
import { requireHostTarget } from "./target";

/**
 * Запрещает маркировать сборку или исполнять output как бинарник другой ОС/архитектуры.
 * Release проверяет чужие target как данные, не вызывает эту границу и не запускает их.
 */
export function assertArtifactHost(target: string): void {
  try {
    requireHostTarget(target);
  } catch (cause) {
    throw new ArtifactError("ARTIFACT_HOST", artifactMessages.host(target), { cause });
  }
}

/**
 * Выбирает tar текущего хоста. На Windows нужен встроенный native bsdtar, а не MSYS tar:
 * последний может интерпретировать C: в абсолютном пути архива как удалённый host.
 */
export function artifactTarExecutable(): string {
  if (process.platform !== "win32") {
    return "tar";
  }
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot) {
    throw new ArtifactError("ARTIFACT_HOST", artifactMessages.windowsTar);
  }
  return join(systemRoot, "System32", "tar.exe");
}
