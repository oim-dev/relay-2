import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, resolve } from "node:path";
import { RelayError } from "@relay/contracts";
import type { GitSyncEnvironment } from "./client.types";
import { gitSyncMessages as messages } from "./git-sync.messages";
import { runNativeProcess } from "./process";

/**
 * Проверяет обычный executable без shell; несуществующий кандидат позволяет продолжить discovery.
 */
function executable(path: string): string | undefined {
  try {
    if (!statSync(path).isFile()) {
      return undefined;
    }
    accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return realpathSync(path);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code))
    ) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Ищет explicit override, sibling, PATH и сборку dev-checkout в этом порядке.
 * Каждый выбранный binary проверяется по версии выпуска; явный override никогда не обходится молча.
 */
export async function discoverGitSyncBinary(environment: GitSyncEnvironment): Promise<string> {
  const name = process.platform === "win32" ? "relay-git-sync.exe" : "relay-git-sync";
  const cliPath = resolve(environment.cwd, environment.executablePath);
  const cliDirectory = dirname(executable(cliPath) ?? cliPath);
  const pathKey =
    process.platform === "win32"
      ? Object.keys(environment.env).find((key) => key.toUpperCase() === "PATH")
      : "PATH";
  const searchPath = pathKey ? environment.env[pathKey] : undefined;
  const checkout =
    basename(dirname(cliDirectory)) === "cli" && basename(dirname(dirname(cliDirectory))) === "apps"
      ? [resolve(cliDirectory, "../../git-sync/dist", name)]
      : [];
  const candidates =
    environment.binary !== undefined
      ? [resolve(environment.cwd, environment.binary)]
      : [
          resolve(dirname(cliPath), name),
          resolve(cliDirectory, name),
          ...(searchPath ?? "")
            .split(delimiter)
            .filter(Boolean)
            .map((directory) => resolve(environment.cwd, directory, name)),
          ...checkout,
          resolve(import.meta.dir, "../../../../apps/git-sync/dist", name),
        ];
  if (environment.binary !== undefined && !environment.binary.trim()) {
    throw new RelayError("GIT_SYNC_BINARY_NOT_FOUND", messages.invalidBinary, 3);
  }
  let incompatible: string | undefined;
  for (const candidate of new Set(candidates)) {
    const path = executable(candidate);
    if (!path) {
      continue;
    }
    const version = await (environment.runner ?? runNativeProcess)({
      executable: path,
      args: ["--version"],
      cwd: environment.cwd,
      env: environment.env,
      strictStdout: true,
      timeoutMs: environment.timeoutMs ?? 10_000,
      ...(environment.signal ? { signal: environment.signal } : {}),
    });
    if (
      version.exitCode === 0 &&
      [environment.version, `relay-git-sync ${environment.version}`].includes(version.stdout.trim())
    ) {
      return path;
    }
    incompatible = path;
    if (environment.binary !== undefined) {
      break;
    }
  }
  if (incompatible) {
    throw new RelayError("GIT_SYNC_VERSION_MISMATCH", messages.incompatibleVersion, 4, {
      binary: incompatible,
      expected: environment.version,
    });
  }
  throw new RelayError("GIT_SYNC_BINARY_NOT_FOUND", messages.binaryMissing, 3);
}
