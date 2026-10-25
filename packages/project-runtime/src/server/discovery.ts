import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, resolve } from "node:path";
import { RelayError } from "@relay/contracts";
import { runNativeProcess } from "../git-sync/process";
import { serverMessages as messages } from "./server.messages";
import type { ServerEnvironment } from "./server.types";

/**
 * Находит обычный исполняемый файл без shell; отсутствие кандидата позволяет продолжить discovery.
 */
function executable(path: string): string | undefined {
  try {
    if (!statSync(path).isFile()) {
      return undefined;
    }
    accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return realpathSync(path);
  } catch (cause) {
    if (
      cause instanceof Error &&
      "code" in cause &&
      ["ENOENT", "ENOTDIR", "EACCES"].includes(String(cause.code))
    ) {
      return undefined;
    }
    throw cause;
  }
}

/**
 * Проверяет exact override, sibling, PATH, затем dev checkout в том же порядке, что Git Sync.
 * --version выполняется под общим guardian; явный несовместимый override никогда не обходится.
 */
export async function discoverServerBinary(environment: ServerEnvironment): Promise<string> {
  const name = process.platform === "win32" ? "relay-server.exe" : "relay-server";
  const cliPath = resolve(environment.cwd, environment.executablePath);
  const directory = dirname(executable(cliPath) ?? cliPath);
  const pathKey =
    process.platform === "win32"
      ? Object.keys(environment.env).find((key) => key.toUpperCase() === "PATH")
      : "PATH";
  const checkout =
    basename(dirname(directory)) === "cli" && basename(dirname(dirname(directory))) === "apps"
      ? [resolve(directory, "../../server/dist", name)]
      : [];
  if (environment.binary !== undefined && !environment.binary.trim()) {
    throw new RelayError("SERVER_BINARY_NOT_FOUND", messages.binaryMissing, 3);
  }
  const candidates =
    environment.binary !== undefined
      ? [resolve(environment.cwd, environment.binary)]
      : [
          resolve(dirname(cliPath), name),
          resolve(directory, name),
          ...(pathKey ? (environment.env[pathKey] ?? "") : "")
            .split(delimiter)
            .filter(Boolean)
            .map((entry) => resolve(environment.cwd, entry, name)),
          ...checkout,
          resolve(import.meta.dir, "../../../../apps/server/dist", name),
        ];
  let incompatible: string | undefined;
  for (const candidate of new Set(candidates)) {
    const path = executable(candidate);
    if (!path) {
      continue;
    }
    const result = await (environment.runner ?? runNativeProcess)({
      executable: path,
      args: ["--version"],
      cwd: environment.cwd,
      env: environment.env,
      timeoutMs: environment.timeoutMs ?? 10_000,
      strictStdout: true,
      ...(environment.signal ? { signal: environment.signal } : {}),
    });
    if (
      result.exitCode === 0 &&
      [environment.version, `relay-server ${environment.version}`].includes(result.stdout.trim())
    ) {
      return path;
    }
    incompatible = path;
    if (environment.binary !== undefined) {
      break;
    }
  }
  if (incompatible) {
    throw new RelayError("SERVER_VERSION_MISMATCH", messages.versionMismatch, 4, {
      binary: incompatible,
      expected: environment.version,
    });
  }
  throw new RelayError("SERVER_BINARY_NOT_FOUND", messages.binaryMissing, 3);
}
