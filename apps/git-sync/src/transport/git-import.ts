import { RelayError } from "@relay/contracts";
import { checkGit } from "./git";
import type { GitExecution } from "./git-objects.types";
import { isGitObjectId } from "./git-objects";
import type { GitFiles } from "./repository.types";
import { transportMessages } from "./transport.messages";

/**
 * Отклоняет некорректный input или ответ private fast-import до изменения local ref.
 */
function invalidImport(): never {
  throw new RelayError("GIT_INVALID_SNAPSHOT", transportMessages.invalidRepository, 4);
}

/**
 * Извлекает OID корневого дерева из ответа fast-import ls на пустой путь.
 */
function rootTree(line: string | undefined): string {
  const match = /^040000 tree ([a-f0-9]+)\t$/.exec(line ?? "");
  const tree = match?.[1];
  if (tree === undefined || !isGitObjectId(tree)) {
    invalidImport();
  }
  return tree;
}

/**
 * Одним fast-import записывает snapshot и получает commit/tree OID через его command protocol.
 * --force касается только временного refs/relay/prepared в private bare: новый кандидат после
 * non-FF может иметь другого parent. Это заменяет прежний delete-ref, не меняя обычный FF push.
 * Совпадающее дерево возвращает parent; caller обновляет local ref только после успешного ответа.
 */
export async function importGitSnapshot(
  run: GitExecution,
  files: GitFiles,
  parent: string | null,
): Promise<string> {
  if (parent !== null && !isGitObjectId(parent)) {
    invalidImport();
  }
  const ordered = [...files].sort(([left], [right]) => left.localeCompare(right, "en"));
  const chunks: (string | Uint8Array)[] = ["feature done\n"];
  for (const [index, [path, bytes]] of ordered.entries()) {
    if (
      !/^[a-zA-Z0-9_./-]+$/.test(path) ||
      path.startsWith("/") ||
      path.split("/").some((part) => part === ".." || part === "." || !part)
    ) {
      invalidImport();
    }
    chunks.push(`blob\nmark :${index + 1}\ndata ${bytes.length}\n`, bytes, "\n");
  }
  const mark = ordered.length + 1;
  chunks.push(
    "reset refs/relay/prepared\n\ncommit refs/relay/prepared\n",
    `mark :${mark}\n`,
    `committer Relay Git Sync <relay@localhost> ${Math.floor(Date.now() / 1000)} +0000\n`,
    "data 23\nRelay data snapshot v1\n\n",
  );
  if (parent !== null) {
    chunks.push(`from ${parent}\n`);
  }
  chunks.push("deleteall\n");
  for (const [index, [path]] of ordered.entries()) {
    chunks.push(`M 100644 :${index + 1} ${path}\n`);
  }
  chunks.push(`\nget-mark :${mark}\nls :${mark} ""\n`);
  if (parent !== null) {
    chunks.push(`ls ${parent} ""\n`);
  }
  chunks.push("done\n");
  const imported = await run(["fast-import", "--quiet", "--done", "--force"], {
    input: Buffer.concat(
      chunks.map((chunk) =>
        typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk),
      ),
    ),
  });
  checkGit(imported, "commit-snapshot");
  const lines = imported.stdout.toString("ascii").split(/\r?\n/);
  const commit = lines[0];
  if (
    commit === undefined ||
    !isGitObjectId(commit) ||
    lines.length !== (parent === null ? 3 : 4) ||
    lines.at(-1) !== ""
  ) {
    invalidImport();
  }
  const tree = rootTree(lines[1]);
  if (parent !== null && tree === rootTree(lines[2])) {
    return parent;
  }
  return commit;
}
