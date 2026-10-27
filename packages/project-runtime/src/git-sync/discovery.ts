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

/**
 * Ищет explicit override, sibling, PATH и сборку dev-checkout в этом порядке.
 * Каждый выбранный binary проверяется по версии выпуска; явный override никогда не обходится молча.
 */
export async function discoverGitSyncBinary(environment: GitSyncEnvironment): Promise<string> {
  const name = nativeExecutableName("relay-git-sync");
  const cliPath = resolve(environment.cwd, environment.executablePath);
  const cliDirectory = dirname(executable(cliPath) ?? cliPath);
  const searchPath = nativeExecutableSearchPath(environment.env);
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
          ...searchPath.map((directory) => resolve(environment.cwd, directory, name)),
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
