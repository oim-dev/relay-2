import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { CliUsageError } from "../../errors/errors";
import { parseInputObject } from "../../input/input";
import { readBoundedText } from "../../input/bounded-text";
import type { ArgumentValues, InputFields } from "../../input/arguments.types";
import type { CliRuntime } from "../../execution/runtime.types";
import { batchCommandMessages as messages } from "../../locales/commands/batch";

const MAX_BATCH_INPUT_BYTES = 8 * 1024 * 1024;

/**
 * Читает единственный источник --input до открытия БД: JSON, @UTF-8-файл либо stdin.
 * Файл разрешается от runtime.cwd и разбирается буквально один раз; его текст не является адресом.
 * Размер любого источника проверяется в байтах UTF-8 перед разбором JSON и предметным выполнением.
 */
export async function readBatchInput(
  values: ArgumentValues,
  runtime: CliRuntime,
): Promise<InputFields> {
  const source = values.input;
  if (typeof source !== "string") {
    throw new CliUsageError(messages.inputRequired);
  }
  if (values.check !== true && !String(values["operation-key"] ?? "").trim()) {
    throw new CliUsageError(messages.operationKeyRequired);
  }
  let text: string;
  try {
    if (source === "-") {
      text =
        typeof runtime.stdin === "function"
          ? await runtime.stdin(MAX_BATCH_INPUT_BYTES)
          : runtime.stdin;
    } else if (source.startsWith("@")) {
      if (source.length === 1) {
        throw new CliUsageError(messages.filePathRequired);
      }
      text = await readBoundedText(
        createReadStream(resolve(runtime.cwd, source.slice(1))),
        MAX_BATCH_INPUT_BYTES,
      );
    } else {
      text = source;
    }
  } catch (cause) {
    if (cause instanceof CliUsageError) {
      throw cause;
    }
    throw new CliUsageError(
      messages.readFailed(cause instanceof Error ? cause.message : String(cause)),
      "INPUT_READ_FAILED",
      { cause },
    );
  }
  if (Buffer.byteLength(text, "utf8") > MAX_BATCH_INPUT_BYTES) {
    throw new CliUsageError(messages.inputTooLarge, "INPUT_TOO_LARGE");
  }
  return parseInputObject(text);
}
