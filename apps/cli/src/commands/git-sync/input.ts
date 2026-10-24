import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { assertGitSyncJson } from "@relay/project-runtime";
import { CliUsageError } from "../../errors/errors";
import type { CliRuntime } from "../../execution/runtime.types";
import type { ArgumentValues, InputFields } from "../../input/arguments.types";
import { readBoundedText } from "../../input/bounded-text";
import { parseInputObject } from "../../input/input";
import { gitSyncCommandMessages as messages } from "../../locales/commands/git-sync";
import type { GitSyncRestoreInput, GitSyncWaitInput } from "./input.types";

const MAX_RESOLUTION_INPUT_BYTES = 8 * 1024 * 1024;

/**
 * Читает ID ожидания и budget без создания новой операции; числовую форму проверяет также argv schema.
 */
export function readGitSyncWaitInput(values: ArgumentValues): GitSyncWaitInput {
  const requestId = values["request-id"];
  const waitMs = values["wait-ms"];
  if (requestId !== undefined && (typeof requestId !== "string" || !requestId.trim())) {
    throw new CliUsageError(messages.requestIdRequired);
  }
  if (
    waitMs !== undefined &&
    (typeof waitMs !== "number" || !Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > 90_000)
  ) {
    throw new CliUsageError(messages.invalidWaitMs);
  }
  return {
    ...(requestId === undefined ? {} : { requestId }),
    ...(waitMs === undefined ? {} : { waitMs }),
  };
}

/**
 * Сохраняет строковый аргумент восстановления дословно; undefined означает отсутствие флага.
 */
function restoreText(values: ArgumentValues, name: string): string | undefined {
  const value = values[name];
  if (value !== undefined && typeof value !== "string") {
    throw new CliUsageError(messages.restoreTextRequired(name));
  }
  return value;
}

/**
 * Разделяет новый Git restore и явный local resume до запуска process port, не открывая config/БД.
 * Возможность выбрать ID без --project-id проверяет Runtime; отсутствующий ID не сериализуется.
 */
export function readRestoreInput(values: ArgumentValues): GitSyncRestoreInput {
  const remote = restoreText(values, "remote");
  const branch = restoreText(values, "branch");
  const projectId = restoreText(values, "project-id");
  if (values.resume !== undefined && typeof values.resume !== "boolean") {
    throw new CliUsageError(messages.resumeBooleanRequired);
  }
  if (values.resume === true) {
    if (remote !== undefined || branch !== undefined) {
      throw new CliUsageError(messages.resumeSourceConflict);
    }
    if (projectId !== undefined && !projectId.trim()) {
      throw new CliUsageError(messages.resumeProjectIdEmpty);
    }
    return { resume: true, ...(projectId === undefined ? {} : { projectId }) };
  }
  if (projectId !== undefined) {
    throw new CliUsageError(messages.projectIdRequiresResume);
  }
  return {
    ...(remote === undefined ? {} : { remote }),
    ...(branch === undefined ? {} : { branch }),
  };
}

/**
 * Читает один источник согласованного решения до запуска Git Sync; ограничивает размер UTF-8.
 */
export async function readResolutionInput(
  values: ArgumentValues,
  runtime: CliRuntime,
): Promise<InputFields> {
  const source = values.input;
  if (typeof source !== "string") {
    throw new CliUsageError(messages.inputRequired);
  }
  let text: string;
  try {
    if (source === "-") {
      text =
        typeof runtime.stdin === "function"
          ? await runtime.stdin(MAX_RESOLUTION_INPUT_BYTES)
          : runtime.stdin;
    } else if (source.startsWith("@")) {
      if (source.length === 1) {
        throw new CliUsageError(messages.filePathRequired);
      }
      text = await readBoundedText(
        createReadStream(resolve(runtime.cwd, source.slice(1))),
        MAX_RESOLUTION_INPUT_BYTES,
      );
    } else {
      text = source;
    }
  } catch (cause) {
    if (cause instanceof CliUsageError) {
      throw cause;
    }
    throw new CliUsageError(
      messages.inputReadFailed(cause instanceof Error ? cause.message : String(cause)),
      "INPUT_READ_FAILED",
      { cause },
    );
  }
  if (Buffer.byteLength(text, "utf8") > MAX_RESOLUTION_INPUT_BYTES) {
    throw new CliUsageError(messages.inputTooLarge, "INPUT_TOO_LARGE");
  }
  const input = parseInputObject(text);
  assertGitSyncJson(input);
  return input;
}
