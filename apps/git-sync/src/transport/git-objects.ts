import { RelayError } from "@relay/contracts";
import { checkGit } from "./git";
import { transportMessages } from "./transport.messages";
import type { GitExecution, GitObject, GitTreeEntry, GitTreeLocation } from "./git-objects.types";

const MAX_BATCH_BYTES = 128 * 1024 * 1024;
const MAX_SNAPSHOT_FILES = 100_000;
const MAX_TREE_DEPTH = 8;
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/**
 * Проверяет полный OID поддерживаемых Git object formats, исключая ref/expressions и input injection.
 */
export function isGitObjectId(value: string): boolean {
  return OBJECT_ID.test(value);
}

/**
 * Отвергает повреждённый batch/tree до передачи байтов snapshot decoder.
 */
function invalidObject(): never {
  throw new RelayError("GIT_INVALID_SNAPSHOT", transportMessages.invalidRepository, 4);
}

/**
 * Читает произвольное число уникальных объектов одним bounded cat-file --batch.
 * Проверяет framing, тип, длину, newline и отсутствие лишних данных; missing не считается пустым blob.
 */
export async function readGitObjects(
  run: GitExecution,
  names: readonly string[],
): Promise<GitObject[]> {
  if (names.length === 0) {
    return [];
  }
  if (names.some((name) => !OBJECT_ID.test(name.replace(/\^\{tree\}$/, "")))) {
    invalidObject();
  }
  const result = await run(["cat-file", "--batch"], {
    input: names.join("\n") + "\n",
    maxBytes: MAX_BATCH_BYTES,
  });
  checkGit(result, "cat-file-batch");
  const objects: GitObject[] = [];
  let offset = 0;
  for (const name of names) {
    const end = result.stdout.indexOf(10, offset);
    if (end < offset || end - offset > 200) {
      invalidObject();
    }
    const header = result.stdout.subarray(offset, end).toString("ascii").split(" ");
    const id = header[0];
    const kind = header[1];
    const length = Number(header[2]);
    if (
      header.length !== 3 ||
      !id ||
      !OBJECT_ID.test(id) ||
      (kind !== "tree" && kind !== "blob" && kind !== "commit") ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      end + length + 1 >= result.stdout.length ||
      result.stdout[end + length + 1] !== 10 ||
      (name.endsWith("^{tree}") ? kind !== "tree" : name !== id)
    ) {
      invalidObject();
    }
    objects.push({ id, kind, bytes: result.stdout.subarray(end + 1, end + length + 1) });
    offset = end + length + 2;
  }
  if (offset !== result.stdout.length) {
    invalidObject();
  }
  return objects;
}

/**
 * Проверяет бинарный tree без checkout, не разрешая symlink, executable, gitlink и неоднозначные имена.
 */
export function decodeGitTree(object: GitObject): GitTreeEntry[] {
  if (object.kind !== "tree") {
    invalidObject();
  }
  const bytes = Buffer.from(object.bytes);
  const hashBytes = object.id.length / 2;
  const entries: GitTreeEntry[] = [];
  const names = new Set<string>();
  let offset = 0;
  while (offset < bytes.length) {
    const end = bytes.indexOf(0, offset);
    if (end < offset || end + 1 + hashBytes > bytes.length) {
      invalidObject();
    }
    const match = /^(40000|100644) ([a-zA-Z0-9_.-]+)$/.exec(
      bytes.subarray(offset, end).toString("utf8"),
    );
    const name = match?.[2];
    if (!name || name === "." || name === ".." || name === ".git" || names.has(name)) {
      invalidObject();
    }
    names.add(name);
    entries.push({
      name,
      kind: match?.[1] === "40000" ? "tree" : "blob",
      id: bytes.subarray(end + 1, end + 1 + hashBytes).toString("hex"),
    });
    offset = end + 1 + hashBytes;
  }
  return entries;
}

/**
 * Материализует несколько snapshot trees пакетами по глубине, а blobs читает одним общим batch.
 * Неизменённые объекты между публикациями читаются один раз и разделяют immutable byte buffers.
 * Число Git subprocess зависит от глубины переносимого layout, не от числа карточек/публикаций.
 */
export async function readGitTrees(
  run: GitExecution,
  heads: readonly string[],
): Promise<Map<string, Map<string, Uint8Array>>> {
  const commits = [...new Set(heads)];
  const roots = await readGitObjects(
    run,
    commits.map((head) => `${head}^{tree}`),
  );
  const trees = new Map<string, GitTreeEntry[]>();
  const indexes = new Map<string, Map<string, string>>();
  let frontier: GitTreeLocation[] = [];
  for (const [index, root] of roots.entries()) {
    const head = commits[index];
    if (!head) {
      invalidObject();
    }
    trees.set(root.id, decodeGitTree(root));
    indexes.set(head, new Map());
    frontier.push({ head, prefix: "", id: root.id });
  }
  for (let depth = 0; frontier.length > 0; depth++) {
    if (depth >= MAX_TREE_DEPTH) {
      invalidObject();
    }
    const missing = [...new Set(frontier.map((entry) => entry.id))].filter((id) => !trees.has(id));
    for (const object of await readGitObjects(run, missing)) {
      trees.set(object.id, decodeGitTree(object));
    }
    const next: GitTreeLocation[] = [];
    for (const location of frontier) {
      const entries = trees.get(location.id);
      const index = indexes.get(location.head);
      if (!entries || !index) {
        invalidObject();
      }
      for (const entry of entries) {
        const path = location.prefix + entry.name;
        if (entry.kind === "tree") {
          next.push({ head: location.head, prefix: path + "/", id: entry.id });
        } else {
          if (index.has(path) || index.size >= MAX_SNAPSHOT_FILES) {
            invalidObject();
          }
          index.set(path, entry.id);
        }
      }
    }
    frontier = next;
  }
  const blobIds = [...new Set([...indexes.values()].flatMap((index) => [...index.values()]))];
  const blobs = new Map<string, Uint8Array>();
  for (const object of await readGitObjects(run, blobIds)) {
    if (object.kind !== "blob") {
      invalidObject();
    }
    blobs.set(object.id, object.bytes);
  }
  const result = new Map<string, Map<string, Uint8Array>>();
  for (const [head, index] of indexes) {
    const files = new Map<string, Uint8Array>();
    for (const [path, id] of index) {
      const bytes = blobs.get(id);
      if (!bytes) {
        invalidObject();
      }
      files.set(path, bytes);
    }
    result.set(head, files);
  }
  return result;
}
