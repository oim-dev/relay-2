import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { ArtifactError } from "./artifacts-error";
import { artifactMessages } from "./artifacts.messages";
import type { ArtifactTarEntry } from "./artifacts.types";
import { artifactTarExecutable } from "./native/host";

const tarBlockSize = 512;

/**
 * Отличает отсутствие пути от ошибок доступа; остальные ошибки не маскируются.
 */
export function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * Проверяет каноническое относительное имя для tar на всех поддержанных ОС.
 * node_modules, управляющие символы и специальные имена Windows не переносятся.
 */
export function isSafeArchivePath(path: string): boolean {
  const segments = path.split("/");
  return segments.every(
    (segment) =>
      segment !== "" &&
      segment !== "." &&
      segment !== ".." &&
      segment.toLowerCase() !== "node_modules" &&
      // oxlint-disable-next-line no-control-regex -- В именах tar явно запрещаем управляющие символы.
      !/[\u0000-\u001f\u007f\\:]/u.test(segment) &&
      !/[. ]$/u.test(segment) &&
      !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment),
  );
}

/**
 * Обходит компоненты относительного пути, не следуя ссылкам; создаёт лишь отсутствующие каталоги.
 */
export async function ensureArtifactDirectories(root: string, directory: string): Promise<void> {
  if (!isSafeArchivePath(directory)) {
    throw new ArtifactError("ARTIFACT_INPUT", artifactMessages.destination(directory));
  }
  let current = root;
  for (const segment of directory.split("/")) {
    current = join(current, segment);
    try {
      const stat = await lstat(current);
      if (!stat.isDirectory()) {
        throw new ArtifactError("ARTIFACT_UNSAFE_ARCHIVE", artifactMessages.destination(current));
      }
    } catch (error) {
      if (!isMissingPath(error)) {
        throw error;
      }
      await mkdir(current);
    }
  }
}

/**
 * Ограничивает временные материалы областью .artifacts checkout и запрещает пути через ссылки.
 */
export async function prepareArtifactWorkspace(root: string, path: string): Promise<string> {
  const absolute = resolve(root, path);
  const local = relative(root, absolute).split(sep).join("/");
  if (!/^\.artifacts\/\d{4}-\d{2}-\d{2}\/.+/u.test(local) || !isSafeArchivePath(local)) {
    throw new ArtifactError("ARTIFACT_INPUT", artifactMessages.workspace(path));
  }
  await ensureArtifactDirectories(root, local);
  return absolute;
}

/**
 * Требует обычный файл передачи или каталог bundle, не принимая symlink за результат CI.
 */
export async function requireArtifactPath(path: string, kind: "file" | "directory"): Promise<void> {
  try {
    const stat = await lstat(path);
    if ((kind === "file" && stat.isFile()) || (kind === "directory" && stat.isDirectory())) {
      return;
    }
  } catch (error) {
    if (!isMissingPath(error)) {
      throw error;
    }
    throw new ArtifactError("ARTIFACT_MISSING", artifactMessages.missing(path), { cause: error });
  }
  throw new ArtifactError("ARTIFACT_MISSING", artifactMessages.missing(path));
}

/**
 * Требует существующее дерево output без symlink в любом компоненте пути от checkout.
 */
export async function requireArtifactDirectory(root: string, directory: string): Promise<void> {
  if (!isSafeArchivePath(directory)) {
    throw new ArtifactError("ARTIFACT_UNSAFE_ARCHIVE", artifactMessages.unsafeArchive);
  }
  let current = root;
  for (const segment of directory.split("/")) {
    current = join(current, segment);
    await requireArtifactPath(current, "directory");
  }
}

/**
 * Проверяет дерево производителя до tar; в output запрещены ссылки и специальные файлы.
 * Обходит имена и stat, но не загружает тела файлов в память.
 */
export async function validateArtifactTree(root: string, directory: string): Promise<void> {
  if (!isSafeArchivePath(directory)) {
    throw new ArtifactError("ARTIFACT_UNSAFE_ARCHIVE", artifactMessages.unsafeArchive);
  }
  await requireArtifactPath(join(root, directory), "directory");
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (!isSafeArchivePath(path) || (!entry.isFile() && !entry.isDirectory())) {
      throw new ArtifactError("ARTIFACT_UNSAFE_ARCHIVE", artifactMessages.unsafeArchive);
    }
    if (entry.isDirectory()) {
      await validateArtifactTree(root, path);
    }
  }
}

/**
 * Выполняет системный tar без shell; stderr и исходный отказ остаются в диагностике CI.
 */
export async function runArtifactTar(args: readonly string[]): Promise<string> {
  const child = Bun.spawn([artifactTarExecutable(), ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    // macOS copyfile metadata не является частью output, передаваемого между ОС.
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) {
    throw new ArtifactError("ARTIFACT_IO", artifactMessages.command("tar", stderr.trim()));
  }
  return stdout;
}

/**
 * Проверяет пути и типы заголовков до распаковки. Разрешены только directory и его потомки.
 * Symlink/hardlink и расширения запрещены независимо от представления GNU/BSD tar.
 */
export function validateArchiveEntries(
  entries: readonly ArtifactTarEntry[],
  directory: string,
): void {
  const seen = new Set<string>();
  if (!isSafeArchivePath(directory)) {
    throw new ArtifactError("ARTIFACT_UNSAFE_ARCHIVE", artifactMessages.unsafeArchive);
  }
  for (const entry of entries) {
    const path = entry.path.replace(/\/$/u, "");
    const isDirectory = entry.type === 53;
    if (
      !isSafeArchivePath(path) ||
      (path !== directory && !path.startsWith(`${directory}/`)) ||
      (!isDirectory && entry.type !== 0 && entry.type !== 48) ||
      (path === directory && !isDirectory) ||
      (!isDirectory && entry.path.endsWith("/")) ||
      (isDirectory && entry.size !== 0) ||
      entry.mode > 0o777 ||
      seen.has(path)
    ) {
      throw new ArtifactError("ARTIFACT_UNSAFE_ARCHIVE", artifactMessages.unsafeArchive);
    }
    seen.add(path);
  }
  if (!seen.has(directory)) {
    throw new ArtifactError("ARTIFACT_UNSAFE_ARCHIVE", artifactMessages.unsafeArchive);
  }
}

/**
 * Декодирует ограниченную NUL-terminated строку USTAR без потери невалидных UTF-8 байтов.
 */
function tarString(header: Buffer, start: number, length: number): string {
  const field = header.subarray(start, start + length);
  const end = field.indexOf(0);
  if (end !== -1 && field.subarray(end).some((byte) => byte !== 0)) {
    throw new ArtifactError("ARTIFACT_UNSAFE_ARCHIVE", artifactMessages.unsafeArchive);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    end === -1 ? field : field.subarray(0, end),
  );
}

/**
 * Разрешает только обычное восьмеричное число USTAR, без base-256 и переполнения.
 */
function tarNumber(header: Buffer, start: number, length: number): number {
  const value = header
    .subarray(start, start + length)
    .toString("utf8")
    .replace(/[\0 ]+$/u, "")
    .trimStart();
  if (!/^[0-7]+$/u.test(value)) {
    throw new ArtifactError("ARTIFACT_UNSAFE_ARCHIVE", artifactMessages.unsafeArchive);
  }
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number)) {
    throw new ArtifactError("ARTIFACT_UNSAFE_ARCHIVE", artifactMessages.unsafeArchive);
  }
  return number;
}

/**
 * Проверяет checksum и фиксированный формат producer, затем декодирует поля одного заголовка.
 */
function decodeTarHeader(header: Buffer): ArtifactTarEntry {
  let checksum = 0;
  for (const [index, byte] of header.entries()) {
    checksum += index >= 148 && index < 156 ? 32 : byte;
  }
  if (
    !header.subarray(257, 265).equals(Buffer.from("ustar\0" + "00")) ||
    checksum !== tarNumber(header, 148, 8) ||
    tarString(header, 157, 100) !== ""
  ) {
    throw new ArtifactError("ARTIFACT_UNSAFE_ARCHIVE", artifactMessages.unsafeArchive);
  }
  const prefix = tarString(header, 345, 155);
  const name = tarString(header, 0, 100);
  return {
    path: prefix ? `${prefix}/${name}` : name,
    type: header[156] ?? -1,
    size: tarNumber(header, 124, 12),
    mode: tarNumber(header, 100, 8),
  };
}

/**
 * Проверяет USTAR до распаковки, читая только заголовки и завершающие нулевые блоки.
 * Формат producer намеренно узкий: нет PAX/GNU overrides, ссылок, устройств и скрытых
 * дополнительных архивов после footer. Тела файлов не десериализуются и не копируются.
 */
export async function validateArtifactArchive(archive: string, directory: string): Promise<void> {
  const file = await open(archive, "r");
  try {
    const size = (await file.stat()).size;
    if (size < tarBlockSize * 2 || size % tarBlockSize !== 0) {
      throw new ArtifactError("ARTIFACT_UNSAFE_ARCHIVE", artifactMessages.unsafeArchive);
    }
    const entries: ArtifactTarEntry[] = [];
    const header = Buffer.alloc(tarBlockSize);
    let offset = 0;
    let footerBlocks = 0;
    while (offset < size) {
      const { bytesRead } = await file.read(header, 0, tarBlockSize, offset);
      if (bytesRead !== tarBlockSize) {
        throw new ArtifactError("ARTIFACT_UNSAFE_ARCHIVE", artifactMessages.unsafeArchive);
      }
      offset += tarBlockSize;
      if (header.every((byte) => byte === 0)) {
        footerBlocks += 1;
        continue;
      }
      if (footerBlocks !== 0) {
        throw new ArtifactError("ARTIFACT_UNSAFE_ARCHIVE", artifactMessages.unsafeArchive);
      }
      const entry = decodeTarHeader(header);
      entries.push(entry);
      offset += Math.ceil(entry.size / tarBlockSize) * tarBlockSize;
    }
    if (offset !== size || footerBlocks < 2) {
      throw new ArtifactError("ARTIFACT_UNSAFE_ARCHIVE", artifactMessages.unsafeArchive);
    }
    validateArchiveEntries(entries, directory);
  } catch (cause) {
    if (cause instanceof ArtifactError) {
      throw cause;
    }
    throw new ArtifactError("ARTIFACT_UNSAFE_ARCHIVE", artifactMessages.unsafeArchive, { cause });
  } finally {
    await file.close();
  }
}

/**
 * Считает SHA-256 потоково, не удерживая сотни мегабайт нативного бинарника в памяти.
 */
export async function artifactDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}
