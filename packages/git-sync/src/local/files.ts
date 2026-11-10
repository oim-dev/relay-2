import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { RelayError } from "@relay/contracts";
import { replaceLocalFile } from "@relay/project-runtime";
import { appMessages } from "../app/app.messages";

/**
 * Читает собственный локальный JSON; отсутствие отличается от повреждения и ошибок доступа.
 */
export function readLocalJson(path: string): unknown | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return undefined;
    }
    const error = new RelayError("GIT_SYNC_STATE_INVALID", appMessages.state, 4, { path });
    error.cause = cause;
    throw error;
  }
}

/**
 * Атомарно публикует приватный JSON; mutex read-modify-write удерживает вызывающий.
 * Относительный path разрешается от cwd процесса; temp синхронизируется и закрывается до замены.
 * Файловые ошибки передаются с исходной причиной, принадлежащий этой попытке temp убирается.
 */
export function writeLocalJson(path: string, value: unknown): void {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  const file = openSync(temporary, "wx", 0o600);
  let closed = false;
  try {
    writeFileSync(file, JSON.stringify(value) + "\n");
    fsyncSync(file);
    closeSync(file);
    closed = true;
    replaceLocalFile(temporary, target);
  } finally {
    if (!closed) {
      closeSync(file);
    }
    rmSync(temporary, { force: true });
  }
}
