import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { hasCode } from "../configuration/files";
import type { ServiceFileStore } from "./service.types";

/**
 * Файловая граница native service; XML Windows пишется с согласованной UTF-16 декларацией и BOM.
 */
export const serviceFiles: ServiceFileStore = {
  /**
   * Возвращает целый файл, отличая отсутствие от ошибок прав/чтения.
   */
  read(path, platform): string | undefined {
    try {
      return readFileSync(path, platform === "win32" ? "utf16le" : "utf8").replace(/^\uFEFF/u, "");
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    }
  },
  /**
   * Публикует конфигурацию атомарной заменой после проверки владения вызывающим контроллером.
   */
  write(path, content, platform): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, platform === "win32" ? `\uFEFF${content}` : content, {
        encoding: platform === "win32" ? "utf16le" : "utf8",
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  },
  /**
   * Удаляет один принадлежащий Relay служебный файл, не обходя каталоги проектов.
   */
  remove(path): void {
    rmSync(path, { force: true });
  },
};
