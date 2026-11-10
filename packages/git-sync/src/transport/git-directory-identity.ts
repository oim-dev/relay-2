import { lstatSync } from "node:fs";
import { RelayError } from "@relay/contracts";
import { transportMessages } from "./transport.messages";

/**
 * Идентифицирует физический Git common-dir независимо от его текущего абсолютного пути.
 * BigInt device/File ID и birthtime отличают rename того же репозитория от нового clone по прежнему пути.
 * При отсутствии надёжной файловой идентичности отказывает, не подменяя её совпадением projectId/URL.
 * Вызывающий заранее разрешает symlink через realpath; ссылка вместо каталога не принимается.
 */
export function gitDirectoryIdentity(directory: string): string {
  const stat = lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.ino <= 0n || stat.birthtimeNs <= 0n) {
    throw new RelayError("GIT_INVALID_REPOSITORY", transportMessages.invalidRepository, 4, {
      path: directory,
      reason: "directory-identity-unavailable",
    });
  }
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
}
