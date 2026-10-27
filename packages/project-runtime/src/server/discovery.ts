import { basename, dirname, resolve } from "node:path";
import {
  nativeExecutableName,
  nativeExecutableSearchPath,
  resolveNativeExecutable as executable,
} from "../native/executable/select";
import { RelayError } from "@relay/contracts";
import { runNativeProcess } from "../git-sync/process";
import { serverMessages as messages } from "./server.messages";
import type { ServerEnvironment } from "./server.types";

/**
 * Проверяет exact override, sibling, PATH, затем dev checkout в том же порядке, что Git Sync.
 * --version выполняется под общим guardian; явный несовместимый override никогда не обходится.
 */
export async function discoverServerBinary(environment: ServerEnvironment): Promise<string> {
  const name = nativeExecutableName("relay-server");
  const cliPath = resolve(environment.cwd, environment.executablePath);
  const directory = dirname(executable(cliPath) ?? cliPath);
  const searchPath = nativeExecutableSearchPath(environment.env);
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
          ...searchPath.map((entry) => resolve(environment.cwd, entry, name)),
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
