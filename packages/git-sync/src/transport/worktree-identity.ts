import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { RelayError } from "@relay/contracts";
import { requireGit } from "./git";
import type { RepositoryGitExecution, RepositoryOptions } from "./repository.types";
import { worktreeMessages as messages } from "./worktree.messages";
import type { WorktreeIdentityOptions } from "./worktree.types";
import { gitDirectoryIdentity } from "./git-directory-identity";

/**
 * Отклоняет несовместимое владение до repair/reset, не изменяя ни одну Git-ссылку.
 */
function mismatch(directory: string): never {
  throw new RelayError("GIT_SYNC_WORKTREE_MISMATCH", messages.identity, 4, { path: directory });
}

/**
 * Читает обычный административный файл; symlink и пропавшая связь не подтверждают владение.
 */
function metadata(path: string, directory: string): string {
  if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) {
    mismatch(directory);
  }
  return readFileSync(path, "utf8").trimEnd();
}

/**
 * Разрешает текущий common-dir и до любых Git-изменений сверяет сохранённую физическую идентичность.
 * Без identity сохраняет прежнюю проверку по связям worktree; такой вызов не разрешает новый вариант repair.
 */
export async function requireDataWorktreeRepository(
  options: RepositoryOptions,
  run: RepositoryGitExecution,
): Promise<string> {
  const context = options.worktree;
  if (context === undefined) {
    throw new RelayError("GIT_INVALID_REPOSITORY", messages.context, 4);
  }
  const common = realpathSync(
    requireGit(
      await run(context.projectDirectory, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]),
      "worktree-common",
    ),
  );
  if (
    context.commonDirectoryIdentity !== undefined &&
    gitDirectoryIdentity(common) !== context.commonDirectoryIdentity
  ) {
    mismatch(common);
  }
  return common;
}

/**
 * Проверяет прямую и обратную gitdir-связи с common-dir, не доверяя имени каталога worktree.
 * Перенос разрешён лишь когда старый checkout исчез; существующая копия остаётся чужим владельцем.
 * При прежнем физическом common-dir допускается также его rename без перемещения data из home.
 * Только после проверки repair может заменить устаревшие абсолютные пути своего worktree.
 * created разрешает однократно записать маркер projectId после успешного add; обычная проверка требует его.
 */
export async function verifyDataWorktree(
  options: RepositoryOptions,
  run: RepositoryGitExecution,
  identity: WorktreeIdentityOptions = {},
): Promise<void> {
  const context = options.worktree;
  if (context === undefined) {
    throw new RelayError("GIT_INVALID_REPOSITORY", messages.context, 4);
  }
  const directory = options.directory;
  const common = await requireDataWorktreeRepository(options, run);
  if (!lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
    mismatch(directory);
  }
  const gitFile = resolve(directory, ".git");
  const pointer = /^gitdir: (.+)$/.exec(metadata(gitFile, directory))?.[1];
  if (pointer === undefined) {
    mismatch(directory);
  }
  const linked = resolve(directory, pointer);
  const candidate = resolve(common, "worktrees", basename(linked));
  if (
    basename(dirname(linked)) !== "worktrees" ||
    !lstatSync(candidate, { throwIfNoEntry: false })?.isDirectory() ||
    (existsSync(linked) && realpathSync(linked) !== realpathSync(candidate))
  ) {
    mismatch(directory);
  }
  const ownCommon = resolve(candidate, metadata(resolve(candidate, "commondir"), directory));
  if (!existsSync(ownCommon) || realpathSync(ownCommon) !== common) {
    mismatch(directory);
  }
  const ownerPath = resolve(candidate, "relay-project");
  if (!identity.created && metadata(ownerPath, directory) !== context.projectId) {
    mismatch(directory);
  }
  const previousGitFile = resolve(candidate, metadata(resolve(candidate, "gitdir"), directory));
  const sameBacklink =
    existsSync(previousGitFile) && realpathSync(previousGitFile) === realpathSync(gitFile);
  if (
    (existsSync(previousGitFile) && !sameBacklink) ||
    (!existsSync(linked) &&
      context.commonDirectoryIdentity === undefined &&
      relative(dirname(previousGitFile), linked) !== relative(directory, candidate)) ||
    metadata(resolve(candidate, "HEAD"), directory) !== `ref: refs/heads/${options.branch}`
  ) {
    mismatch(directory);
  }
  if (!existsSync(linked) || !sameBacklink) {
    if (!identity.repair) {
      mismatch(directory);
    }
    requireGit(
      await run(context.projectDirectory, ["worktree", "repair", directory]),
      "worktree-repair",
    );
  }
  const root = requireGit(await run(directory, ["rev-parse", "--show-toplevel"]), "worktree-root");
  const head = requireGit(await run(directory, ["symbolic-ref", "HEAD"]), "worktree-head");
  if (realpathSync(root) !== realpathSync(directory) || head !== `refs/heads/${options.branch}`) {
    mismatch(directory);
  }
  if (identity.created) {
    // Только успешный add создаёт новое владение; существующий worktree нельзя присвоить по имени ветки.
    writeFileSync(ownerPath, context.projectId + "\n", { flag: "wx", mode: 0o600 });
  }
}
