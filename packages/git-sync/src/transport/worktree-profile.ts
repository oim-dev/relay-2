import { RelayError } from "@relay/contracts";
import { requireGit } from "./git";
import type { RepositoryGitExecution } from "./repository.types";
import { worktreeMessages as messages } from "./worktree.messages";

/**
 * Изолирует checkout от пользовательских CRLF, глобальных attributes, sparse и fsmonitor.
 * Параметры действуют только на команду; Git config исходного проекта не переписывается.
 * /dev/null понимает и Git for Windows. Общий info/attributes отдельно проверяется до checkout.
 */
export function worktreeGitArguments(args: readonly string[]): readonly string[] {
  return [
    "-c",
    "core.attributesFile=/dev/null",
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.eol=lf",
    "-c",
    "core.safecrlf=false",
    "-c",
    "core.sparseCheckout=false",
    "-c",
    "core.sparseCheckoutCone=false",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.ignorestat=false",
    "-c",
    "core.untrackedCache=false",
    ...args,
  ];
}

/**
 * Не разрешает локальным info/attributes запускать filters или преобразовывать portable bytes.
 * Git не имеет per-call отключения info/attributes: несовместимое правило отклоняется до записи.
 * Снимки Relay не содержат собственных .gitattributes; постороннее дерево не материализуется.
 */
export async function requireRawWorktreePaths(
  directory: string,
  paths: readonly string[],
  run: RepositoryGitExecution,
): Promise<void> {
  if (paths.length === 0) {
    return;
  }
  if (paths.some((path) => path.split("/").includes(".gitattributes"))) {
    throw new RelayError("GIT_SYNC_WORKTREE_ATTRIBUTES", messages.attributes, 4, {
      path: directory,
    });
  }
  const result = await run(
    directory,
    ["check-attr", "-z", "--stdin", "filter", "text", "eol", "ident", "working-tree-encoding"],
    {
      input: paths.join("\0") + "\0",
    },
  );
  requireGit(result, "worktree-attributes");
  const values = result.stdout.toString("utf8").split("\0");
  for (let index = 2; index < values.length; index += 3) {
    if (values[index] !== "unspecified" && values[index] !== "unset") {
      throw new RelayError("GIT_SYNC_WORKTREE_ATTRIBUTES", messages.attributes, 4, {
        path: values[index - 2],
        attribute: values[index - 1],
      });
    }
  }
}
