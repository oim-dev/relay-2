import { lstatSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { RelayError } from "@relay/contracts";
import { requireGit } from "./git";
import type { RepositoryGitExecution, RepositoryOptions } from "./repository.types";
import { worktreeMessages as messages } from "./worktree.messages";
import { requireDataWorktreeRepository, verifyDataWorktree } from "./worktree-identity";
import { requireRawWorktreePaths } from "./worktree-profile";

/**
 * Проверяет чистоту checkout, включая ignored-файлы и скрывающие изменения флаги index.
 * Преобразующие attributes отклоняются до status, который иначе мог бы запустить clean filter.
 */
async function requireCleanWorktree(
  options: RepositoryOptions,
  run: RepositoryGitExecution,
): Promise<void> {
  const listing = await run(options.directory, ["ls-files", "-v", "-z"]);
  requireGit(listing, "worktree-index");
  const records = listing.stdout.toString("utf8").split("\0").filter(Boolean);
  if (records.some((record) => !record.startsWith("H "))) {
    throw new RelayError("GIT_SYNC_WORKTREE_DIRTY", messages.dirty, 4, { path: options.directory });
  }
  await requireRawWorktreePaths(
    options.directory,
    records.map((record) => record.slice(2)),
    run,
  );
  const status = requireGit(
    await run(options.directory, [
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--ignored=matching",
      "--ignore-submodules=none",
    ]),
    "worktree-status",
  );
  if (status.length > 0) {
    throw new RelayError("GIT_SYNC_WORKTREE_DIRTY", messages.dirty, 4, { path: options.directory });
  }
}

/**
 * Создаёт linked worktree на orphan-ветке либо восстанавливает ветку, известную private refs реплики.
 * Основной HEAD/index не изменяются; чужие ветки, каталоги и worktree без маркера владельца отклоняются.
 */
export async function initializeDataWorktree(
  options: RepositoryOptions,
  run: RepositoryGitExecution,
  ownedRefs: readonly string[],
): Promise<void> {
  const context = options.worktree;
  if (context === undefined) {
    throw new RelayError("GIT_INVALID_REPOSITORY", messages.context, 4);
  }
  const root = context.projectDirectory;
  // Проверка Git/отмены предшествует созданию каталогов и любого worktree.
  await requireDataWorktreeRepository(options, run);
  const sourceHead = await run(root, ["symbolic-ref", "--quiet", "HEAD"]);
  if (
    sourceHead.exitCode !== 1 &&
    requireGit(sourceHead, "worktree-source-head") === `refs/heads/${options.branch}`
  ) {
    throw new RelayError("GIT_SYNC_WORKTREE_MISMATCH", messages.identity, 4, { path: root });
  }
  if (!lstatSync(resolve(options.directory, ".git"), { throwIfNoEntry: false })) {
    const directory = lstatSync(options.directory, { throwIfNoEntry: false });
    if (directory && (!directory.isDirectory() || readdirSync(options.directory).length > 0)) {
      throw new RelayError("GIT_SYNC_WORKTREE_DIRTY", messages.dirty, 4, {
        path: options.directory,
      });
    }
    mkdirSync(dirname(options.directory), { recursive: true, mode: 0o700 });
    const branch = await run(root, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${options.branch}`,
    ]);
    if (branch.exitCode !== 0 && branch.exitCode !== 1) {
      requireGit(branch, "worktree-branch");
    }
    if (branch.exitCode === 0) {
      const known = requireGit(
        await run(root, ["for-each-ref", "--format=%(objectname)", ...ownedRefs]),
        "worktree-owned-heads",
      ).split("\n");
      if (!known.includes(requireGit(branch, "worktree-branch"))) {
        throw new RelayError("GIT_SYNC_WORKTREE_MISMATCH", messages.identity, 4, {
          path: options.directory,
        });
      }
    }
    const args =
      branch.exitCode === 0
        ? ["worktree", "add", "--no-checkout", options.directory, options.branch]
        : ["worktree", "add", "--orphan", "-b", options.branch, options.directory];
    requireGit(await run(root, args), "worktree-add");
    await verifyDataWorktree(options, run, { created: true });
    if (branch.exitCode === 0) {
      // Новый checkout ещё пуст; проверяем target attributes до первой материализации.
      await checkoutCommit(options, "HEAD", run);
    }
  }
  await verifyDataWorktree(options, run, { repair: true });
  await requireCleanWorktree(options, run);
}

/**
 * Проверяет преобразования будущего дерева до reset; входной commit уже проверен владельцем snapshot.
 */
async function checkoutCommit(
  options: RepositoryOptions,
  head: string,
  run: RepositoryGitExecution,
): Promise<void> {
  const tree = await run(options.directory, ["ls-tree", "-r", "--name-only", "-z", head]);
  requireGit(tree, "worktree-target");
  await requireRawWorktreePaths(
    options.directory,
    tree.stdout.toString("utf8").split("\0").filter(Boolean),
    run,
  );
  requireGit(await run(options.directory, ["reset", "--hard", head]), "worktree-materialize");
}

/**
 * Материализует уже созданный/проверенный commit только в чистом служебном checkout.
 * Повторно проверяет владельца/ветку перед записью; Git-профиль исключает checkout-преобразования.
 * Проверка и reset сериализованы владельцем реплики, но не образуют защиту от параллельного ручного Git.
 */
export async function materializeDataWorktree(
  options: RepositoryOptions,
  head: string,
  run: RepositoryGitExecution,
): Promise<void> {
  if (options.worktree === undefined) {
    return;
  }
  await verifyDataWorktree(options, run);
  await requireCleanWorktree(options, run);
  await checkoutCommit(options, head, run);
}
