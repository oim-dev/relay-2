import type { ProcessInput, ProcessResult } from "./process.types";

/**
 * Уже привязанный к private repo и guardian исполнитель Git plumbing.
 */
export type GitExecution = (
  args: readonly string[],
  options?: Partial<ProcessInput>,
) => Promise<ProcessResult>;

/**
 * Ограниченный ответ cat-file; payload — исходные байты без UTF-8 преобразования.
 */
export interface GitObject {
  /* Object ID из заголовка batch response. */
  readonly id: string;
  /* Разрешённый тип объекта этого reader. */
  readonly kind: "tree" | "blob" | "commit";
  /* Байты содержимого, принадлежащие общему ограниченному batch buffer. */
  readonly bytes: Uint8Array;
}

/**
 * Запись бинарного tree; другие режимы, включая symlink/gitlink, отвергаются.
 */
export interface GitTreeEntry {
  /* Только один безопасный ASCII path component. */
  readonly name: string;
  /* tree или обычный неисполняемый blob. */
  readonly kind: "tree" | "blob";
  /* Идентичность дочернего объекта. */
  readonly id: string;
}

/**
 * Одна позиция обхода набора immutable Git trees.
 */
export interface GitTreeLocation {
  /* Commit, для которого собирается файл. */
  readonly head: string;
  /* Относительный префикс, включая конечный slash у непустого пути. */
  readonly prefix: string;
  /* ID текущего tree. */
  readonly id: string;
}
