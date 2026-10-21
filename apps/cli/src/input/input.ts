import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Args } from "gunshi";
import type { ArgumentValues, InputFields } from "./arguments.types";
import { CliUsageError } from "../errors/errors";
import { argumentMessages } from "../locales/arguments";
import type { CliRuntime } from "../execution/runtime.types";

const FILE_OPTION_SUFFIX = "-file";
const MAX_INPUT_MEBIBYTES = 128;
const MAX_INPUT_BYTES = MAX_INPUT_MEBIBYTES * 1024 * 1024;

/**
 * Переименовывает CLI-алиасы в копии объекта, сохраняя исходный ввод.
 * Одновременная передача алиаса и целевого поля отклоняется, включая значения null и false.
 */
export function remapInput(
  input: InputFields,
  aliases: Readonly<Record<string, string>>,
): InputFields {
  const result = { ...input };
  for (const [source, target] of Object.entries(aliases)) {
    if (!Object.hasOwn(result, source)) {
      continue;
    }
    if (Object.hasOwn(result, target)) {
      throw new CliUsageError(
        argumentMessages.conflictingFields(source, target),
        "CONFLICTING_OPTIONS",
      );
    }
    result[target] = result[source];
    delete result[source];
  }
  return result;
}

/**
 * Преобразует дефисное имя CLI-параметра в имя поля Core, не меняя остальные символы.
 */
export function camelCase(name: string): string {
  return name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/**
 * Распознаёт объект внешнего JSON-ввода; массив и null не являются набором полей.
 */
function isInputObject(value: unknown): value is InputFields {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Декодирует --input без подмены ошибочного JSON пустым объектом; сохраняет причину ошибки.
 */
export function parseInputObject(text: string): InputFields {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new CliUsageError(argumentMessages.invalidInputJson, "INVALID_JSON", { cause });
  }
  if (!isInputObject(value)) {
    throw new CliUsageError(argumentMessages.inputObjectRequired, "INVALID_JSON");
  }
  return value;
}

/**
 * Проверяет все источники до первого чтения, исключая конкурирующих потребителей stdin.
 * Возвращает только переданные поля схемы, сохраняя их порядок.
 */
function selectInputSources(values: ArgumentValues, fields: Args): string[] {
  const supplied = Object.keys(fields).filter((key) => values[key] !== undefined);
  const files = supplied.filter((key) => key.endsWith(FILE_OPTION_SUFFIX));
  if (files.filter((key) => values[key] === "-").length > 1) {
    throw new CliUsageError(argumentMessages.sharedStdin, "CONFLICTING_OPTIONS");
  }
  for (const file of files) {
    const field = file.slice(0, -FILE_OPTION_SUFFIX.length);
    if (values[field] !== undefined) {
      throw new CliUsageError(
        argumentMessages.conflictingSources(field, file),
        "CONFLICTING_OPTIONS",
      );
    }
  }
  const wholeInput = values.input !== undefined || values["input-file"] !== undefined;
  if (wholeInput && supplied.some((key) => key !== "input" && key !== "input-file")) {
    throw new CliUsageError(argumentMessages.mixedInput, "CONFLICTING_OPTIONS");
  }
  return supplied;
}

/**
 * Читает файловый источник или stdin целиком в UTF-8 и проверяет размер полученного текста.
 * Путь разрешается относительно runtime.cwd; значимые пробелы сохраняются дословно.
 */
async function readFileSource(key: string, value: unknown, runtime: CliRuntime): Promise<string> {
  let text: string;
  try {
    if (value === "-") {
      text = typeof runtime.stdin === "function" ? await runtime.stdin() : runtime.stdin;
    } else {
      text = await readFile(resolve(runtime.cwd, String(value)), "utf8");
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new CliUsageError(argumentMessages.readFailed(key, message), "INPUT_READ_FAILED", {
      cause,
    });
  }
  if (Buffer.byteLength(text, "utf8") > MAX_INPUT_BYTES) {
    throw new CliUsageError(
      argumentMessages.fileTooLarge(key, MAX_INPUT_MEBIBYTES),
      "INPUT_TOO_LARGE",
    );
  }
  return text;
}

/**
 * Применяет к файлу тот же parser, что Gunshi применяет к inline-значению.
 * Предметная диагностика сохраняется; ошибка декодирования получает имя файлового параметра.
 */
function parseFileSource(key: string, field: string, text: string, fields: Args): unknown {
  const schema = fields[field];
  if (schema?.type !== "custom" || !schema.parse) {
    return text;
  }
  try {
    return schema.parse(text);
  } catch (cause) {
    if (cause instanceof CliUsageError) {
      throw cause;
    }
    throw new CliUsageError(argumentMessages.invalidFileJson(key), "INVALID_JSON", { cause });
  }
}

/**
 * Читает поля одного вызова после проверки конфликтов источников.
 * Inline JSON обычно уже разобран Gunshi; прямой вызов допускает его строковую форму.
 * Файлы читаются до открытия БД; предметную проверку значений выполняет выбранный сервис Core.
 */
export async function readInput(
  values: ArgumentValues,
  fields: Args,
  runtime: CliRuntime,
): Promise<InputFields> {
  const supplied = selectInputSources(values, fields);
  const result: InputFields = {};
  for (const key of supplied) {
    const isFile = key.endsWith(FILE_OPTION_SUFFIX);
    const field = isFile ? key.slice(0, -FILE_OPTION_SUFFIX.length) : key;
    let value = values[key];
    if (isFile) {
      value = parseFileSource(key, field, await readFileSource(key, value, runtime), fields);
    }
    if (field === "input") {
      if (typeof value === "string") {
        const schema = fields.input;
        if (!schema?.parse) {
          throw new Error(argumentMessages.inputParserRequired);
        }
        value = schema.parse(value);
      }
      if (!isInputObject(value)) {
        throw new CliUsageError(argumentMessages.inputObjectRequired, "INVALID_JSON");
      }
      return value;
    }
    result[camelCase(field)] = value;
  }
  return result;
}

/**
 * Возвращает обязательное непустое текстовое поле, сохраняя переданные пробелы.
 */
export function requiredText(input: InputFields, name: string): string {
  const value = input[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new CliUsageError(argumentMessages.requiredText(name));
  }
  return value;
}

/**
 * Отвергает первое неизвестное имя поля до передачи данных в предметный сценарий.
 */
export function onlyFields(input: InputFields, allowed: readonly string[]): void {
  const unknown = Object.keys(input).find((key) => !allowed.includes(key));
  if (unknown) {
    throw new CliUsageError(argumentMessages.unknownField(unknown));
  }
}
