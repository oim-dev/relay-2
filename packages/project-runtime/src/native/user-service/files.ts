import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { hasCode } from "../../configuration/files";
import { replaceLocalFile } from "../../local-files/replace";
import type {
  ServiceConfiguration,
  ServiceFileStore,
  UserServiceAdapter,
  UserServiceContext,
  UserServiceFiles,
} from "./service.types";

/**
 * Связывает совместимый тестовый порт с уже выбранной ОС; production использует файлы адаптера.
 */
export function bindUserServiceFiles(
  adapter: UserServiceAdapter,
  files?: ServiceFileStore,
): UserServiceFiles {
  if (files === undefined) {
    return adapter.files;
  }
  return {
    /**
     * Передаёт целевую ОС подмене, не выбирая кодировку самостоятельно.
     */
    read: (path): string | undefined => files.read(path, adapter.platform),
    /**
     * Публикует через подмену выбранного менеджера.
     */
    write: (path, content): void => files.write(path, content, adapter.platform),
    /**
     * Удаляет ровно указанный служебный файл.
     */
    remove: (path): void => files.remove(path),
  };
}

/**
 * Проверяет принадлежность локального манифеста до любого обращения к manager.
 * Отсутствующий файл возвращает false; чужой файл и ошибки чтения не маскируются.
 */
export function ownsServiceConfiguration(
  config: ServiceConfiguration,
  context: UserServiceContext,
): boolean {
  const content = context.files.read(config.path);
  if (content !== undefined && !content.includes(config.marker)) {
    throw context.failure("ownership", 4, { path: config.path });
  }
  return content !== undefined;
}

/**
 * Создаёт файловый порт с явными кодировкой и BOM. Сам не выбирает ОС;
 * атомарная замена физического файла принадлежит общему механизму local-files.
 */
export function createUserServiceFiles(
  encoding: "utf8" | "utf16le",
  prefix: string,
): UserServiceFiles {
  return {
    /**
     * Отличает отсутствие от ошибок доступа/чтения и снимает необязательный BOM.
     */
    read(path): string | undefined {
      try {
        return readFileSync(path, encoding).replace(/^\uFEFF/u, "");
      } catch (error) {
        if (hasCode(error, "ENOENT")) {
          return undefined;
        }
        throw error;
      }
    },
    /**
     * Публикует целый файл после проверки ownership вызывающим; временный файл принадлежит попытке.
     */
    write(path, content): void {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, `${prefix}${content}`, { encoding, mode: 0o600, flag: "wx" });
        replaceLocalFile(temporary, path);
      } finally {
        rmSync(temporary, { force: true });
      }
    },
    /**
     * Удаляет только принадлежащий Relay служебный файл, не обходя каталоги проектов.
     */
    remove(path): void {
      rmSync(path, { force: true });
    },
  };
}
