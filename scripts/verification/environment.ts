import { join } from "node:path";
import { repository } from "./catalog";
import { verificationMessages } from "./verification.messages";

/**
 * Проверяет одинаковые для check и CI версии инструментов до запуска графа.
 * Ничего не устанавливает, не читает пользовательские проекты и не записывает отчёты.
 */
export async function verifyEnvironment(): Promise<void> {
  const manifest: unknown = await Bun.file(join(repository, "package.json")).json();
  const bun = (await Bun.file(join(repository, ".bun-version")).text()).trim();
  const node = (await Bun.file(join(repository, ".node-version")).text()).trim();
  if (
    Bun.version !== bun ||
    !manifest ||
    typeof manifest !== "object" ||
    !("packageManager" in manifest) ||
    manifest.packageManager !== `bun@${bun}` ||
    !("engines" in manifest) ||
    !manifest.engines ||
    typeof manifest.engines !== "object" ||
    !("bun" in manifest.engines) ||
    manifest.engines.bun !== bun
  ) {
    throw new Error(verificationMessages.bunRequired(bun, Bun.version));
  }
  const version = Bun.spawnSync(["node", "--version"], { stdout: "pipe", stderr: "pipe" });
  if (version.exitCode !== 0 || version.stdout.toString().trim() !== `v${node}`) {
    throw new Error(verificationMessages.nodeRequired(node));
  }
  const git = Bun.spawnSync(["git", "--version"], { stdout: "pipe", stderr: "pipe" });
  if (git.exitCode !== 0) {
    throw new Error(verificationMessages.gitRequired);
  }
  console.log(verificationMessages.environment(bun, node, git.stdout.toString().trim()));
}

if (import.meta.main) {
  await verifyEnvironment();
}
