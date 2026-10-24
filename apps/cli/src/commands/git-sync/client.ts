import { homedir } from "node:os";
import {
  createGitSyncClient,
  createNativeProcessRunner,
  type GitSyncClient,
} from "@relay/project-runtime";
import { version } from "../../../package.json";
import type { LocalInvocation } from "../../execution/local-invocation";

/**
 * Подключает процессный порт с явными cwd/env/потоками; бинарник ищется только при действии.
 * Compiled CLI использует собственную private guardian-роль, отдельно от проверяемого компонента.
 */
export function gitSyncClient(invocation: LocalInvocation): GitSyncClient {
  const runtime = invocation.runtime;
  return (
    runtime.gitSync ??
    createGitSyncClient({
      cwd: runtime.cwd,
      env: runtime.env,
      version,
      executablePath: runtime.executablePath ?? process.execPath,
      userHome: runtime.env.HOME ?? runtime.env.USERPROFILE ?? homedir(),
      ...(Bun.isStandaloneExecutable
        ? { runner: createNativeProcessRunner([runtime.executablePath ?? process.execPath]) }
        : {}),
      ...(runtime.env.RELAY_GIT_SYNC_BIN !== undefined
        ? { binary: runtime.env.RELAY_GIT_SYNC_BIN }
        : {}),
      ...(runtime.signal ? { signal: runtime.signal } : {}),
      ...(runtime.stdout ? { stdout: runtime.stdout } : {}),
      ...(runtime.stderr ? { stderr: runtime.stderr } : {}),
    })
  );
}
