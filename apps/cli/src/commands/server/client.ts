import { homedir } from "node:os";
import {
  createNativeProcessRunner,
  createServerClient,
  type ServerClient,
} from "@relay/project-runtime";
import { version } from "../../../package.json";
import type { LocalInvocation } from "../../execution/local-invocation";

/**
 * Подключает ленивый серверный порт с явной средой; standalone CLI предоставляет собственный guardian.
 */
export function serverClient(invocation: LocalInvocation): ServerClient {
  const runtime = invocation.runtime;
  return (
    runtime.server ??
    createServerClient({
      cwd: runtime.cwd,
      env: runtime.env,
      version,
      executablePath: runtime.executablePath ?? process.execPath,
      userHome: runtime.env.HOME ?? runtime.env.USERPROFILE ?? homedir(),
      ...(Bun.isStandaloneExecutable
        ? { runner: createNativeProcessRunner([runtime.executablePath ?? process.execPath]) }
        : {}),
      ...(runtime.env.RELAY_SERVER_BIN !== undefined
        ? { binary: runtime.env.RELAY_SERVER_BIN }
        : {}),
      ...(runtime.signal ? { signal: runtime.signal } : {}),
      ...(runtime.stdout ? { stdout: runtime.stdout } : {}),
      ...(runtime.stderr ? { stderr: runtime.stderr } : {}),
    })
  );
}
