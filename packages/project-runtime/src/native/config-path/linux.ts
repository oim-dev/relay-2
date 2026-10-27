import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileMessages } from "../../configuration/files.messages";

/**
 * Сохраняет порядок symlink и следующих за ними `..` в Linux-цели файловой ссылки.
 */
function physicalDirectory(path: string): string {
  if (!path.split("/").includes("..")) {
    return realpathSync(path);
  }
  const directory = physicalDirectory(dirname(path));
  const name = basename(path);
  return name === ".." ? dirname(directory) : realpathSync(join(directory, name));
}

/**
 * Разрешает конечные ссылки без realpath самого заменяемого inode: Linux /proc/self/fd
 * после rename может вернуть имя с суффиксом (deleted). Настоящий такой суффикс сохраняется.
 */
export function linuxConfigPath(path: string): string {
  const links = new Set<string>();
  let current = path;
  for (;;) {
    const directory = physicalDirectory(dirname(current));
    const file = join(directory, basename(current));
    if (!lstatSync(file).isSymbolicLink()) {
      return file;
    }
    if (links.has(file)) {
      throw Object.assign(new Error(fileMessages.symbolicLinkCycle(path)), {
        code: "ELOOP",
        syscall: "readlink",
        path,
      });
    }
    links.add(file);
    const target = readlinkSync(file);
    current = isAbsolute(target) ? target : `${directory}/${target}`;
  }
}
