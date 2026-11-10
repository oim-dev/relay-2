import {
  decodeGitSyncRequest,
  GIT_SYNC_REQUEST_MAX_BYTES,
  RelayError,
  type GitSyncResponse,
} from "@relay/contracts";
import type { CliRuntime } from "../execution/runtime.types";
import type { CliOutput } from "./run.types";
import { gitSyncClient } from "../execution/git-sync-client";
import { describeCliFailure } from "../errors/errors";
import { synchronizationMessages as messages } from "../locales/synchronization";
import { probeDefaultSsh } from "@relay/git-sync";

/**
 * Обслуживает один Server → CLI запрос без Gunshi и без рекурсивного автоматического hook.
 * Вход ограничен общим wire budget; stdout содержит ровно один совместимый envelope.
 */
export async function runGitSyncRequest(runtime: CliRuntime, output: CliOutput): Promise<number> {
  let response: GitSyncResponse;
  try {
    const source =
      typeof runtime.stdin === "function"
        ? await runtime.stdin(GIT_SYNC_REQUEST_MAX_BYTES)
        : runtime.stdin;
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch {
      throw new RelayError("GIT_SYNC_INVALID_REQUEST", messages.invalidRequest, 2);
    }
    response = {
      version: 1,
      ok: true,
      data: await gitSyncClient(runtime).request(decodeGitSyncRequest(value)),
    };
  } catch (error) {
    const { invalidInput: _invalidInput, ...failure } = describeCliFailure(error);
    response = { version: 1, ok: false, error: failure };
  }
  output.stdout(`${JSON.stringify(response)}\n`);
  return response.ok ? 0 : response.error.exitCode;
}

/**
 * Исполняет приватную SSH-пробу, вызываемую Git в его точной среде; проектная БД не открывается.
 */
export async function runGitSyncSshProbe(output: CliOutput, directory?: string): Promise<number> {
  try {
    output.stdout(`${JSON.stringify(await probeDefaultSsh(directory))}\n`);
    return 0;
  } catch (error) {
    const failure = describeCliFailure(error);
    output.stderr(`${failure.code}: ${failure.message}\n`);
    return failure.exitCode;
  }
}
