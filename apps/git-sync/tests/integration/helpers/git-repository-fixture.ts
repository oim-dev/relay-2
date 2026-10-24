import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DataRepository } from "../../../src/transport/repository";
import { git, requireGit } from "../../../src/transport/git";
import { withGitProcessRuntime } from "../../../src/transport/process-runtime";

/**
 * Изолирует только Git object database, без текущего SQL/domain-контракта и пользовательских configs.
 */
export async function withGitRepository(
  operation: (
    repository: DataRepository,
    root: string,
    env: Readonly<Record<string, string | undefined>>,
  ) => Promise<void>,
): Promise<void> {
  const parent = fileURLToPath(
    new URL(
      `../../../../../.artifacts/${new Date().toISOString().slice(0, 10)}/git-sync-implementation/git-sync/git-only/`,
      import.meta.url,
    ),
  );
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "repository-"));
  const config = join(root, "gitconfig");
  writeFileSync(config, "");
  const env = {
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_SYSTEM: config,
    GIT_CONFIG_COUNT: undefined,
    GIT_CONFIG_PARAMETERS: undefined,
    GIT_AUTHOR_NAME: "Relay fixture",
    GIT_AUTHOR_EMAIL: "fixture@localhost",
    GIT_COMMITTER_NAME: "Relay fixture",
    GIT_COMMITTER_EMAIL: "fixture@localhost",
  };
  try {
    await withGitProcessRuntime(
      async () => {
        const remote = join(root, "remote.git");
        requireGit(await git(root, ["init", "--bare", remote], { env }), "create-remote");
        const repository = new DataRepository({
          directory: join(root, "private.git"),
          remote,
          branch: "relay-data-v2",
          env,
        });
        await repository.initialize();
        await operation(repository, root, env);
      },
      join(root, "process-runtime"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
