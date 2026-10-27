import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { repository, targets } from "../verification/catalog";
import type { ArtifactFixture } from "./artifacts.test.types";

/**
 * Записывает обычный файл fixture; режим исполняемого файла задаётся явно вызывающим тестом.
 */
export async function writeArtifactFixtureFile(
  path: string,
  content: string,
  mode = 0o644,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  await chmod(path, mode);
}

/**
 * Владеет минимальным изолированным checkout под .artifacts/дата/ci-check.
 * Не создаёт настоящие сборки, процессы приложений, БД или node_modules; данные задаёт тест.
 */
export async function withArtifactFixture(
  run: (fixture: ArtifactFixture) => Promise<void>,
): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const parent = join(repository, ".artifacts", date, "ci-check");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "artifacts-"));
  const host = targets.find(
    (target) => target.platform === process.platform && target.arch === process.arch,
  );
  if (!host) {
    await rm(root, { recursive: true, force: true });
    throw new Error("Fixture требует один из поддержанных CI-хостов");
  }
  try {
    await run({
      context: { root, sha: "a".repeat(40), toolchain: { bun: "1.4.3", node: "24.18.1" } },
      downloads: join(root, ".artifacts", date, "ci-check", "downloads"),
      target: host.id,
      cliBinary: process.platform === "win32" ? "apps/cli/dist/relay.exe" : "apps/cli/dist/relay",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
