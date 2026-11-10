import { basename, dirname, resolve } from "node:path";
import {
  nativeExecutableName,
  nativeExecutableSearchPath,
  resolveNativeExecutable as executable,
} from "../native/executable/select";
import { RelayError } from "@relay/contracts";
import type { GitSyncEnvironment } from "./client.types";
import { gitSyncMessages as messages } from "./git-sync.messages";
import { runNativeProcess } from "./process";

const VERSION_PROBE_TIMEOUT_MS = 10_000;

/**
 * Ищет relay CLI: explicit override, sibling, PATH и apps/cli/dist dev-checkout в этом порядке.
 * Каждый выбранный binary проверяется по версии выпуска; явный override никогда не обходится молча.
 */
export async function discoverGitSyncBinary(environment: GitSyncEnvironment): Promise<string> {
  const name = nativeExecutableName("relay");
  const callerPath = resolve(environment.cwd, environment.executablePath);
  const callerDirectory = dirname(executable(callerPath) ?? callerPath);
  const searchPath = nativeExecutableSearchPath(environment.env);
  const checkout =
    ["cli", "server"].includes(basename(dirname(callerDirectory))) &&
    basename(dirname(dirname(callerDirectory))) === "apps"
      ? [resolve(callerDirectory, "../../cli/dist", name)]
      : [];
  const candidates =
    environment.binary !== undefined
      ? [resolve(environment.cwd, environment.binary)]
      : [
          resolve(dirname(callerPath), name),
          resolve(callerDirectory, name),
          ...searchPath.map((directory) => resolve(environment.cwd, directory, name)),
          ...checkout,
          resolve(import.meta.dir, "../../../../apps/cli/dist", name),
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
      timeoutMs: environment.timeoutMs ?? VERSION_PROBE_TIMEOUT_MS,
      ...(environment.signal ? { signal: environment.signal } : {}),
    });
    if (
      version.exitCode === 0 &&
      [environment.version, `relay ${environment.version}`].includes(version.stdout.trim())
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
