import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Args, ArgSchema } from "gunshi";
import { CliUsageError } from "./errors";
import type { CliRuntime } from "./runtime";

export const string = (description: string, required = false): ArgSchema => ({
  type: "string",
  description,
  required,
});
export const positional = (description: string, required = true): ArgSchema => ({
  type: "positional",
  description,
  required,
});
export const flag = (description: string): ArgSchema => ({ type: "boolean", description });
export const repeated = (description: string): ArgSchema => ({
  type: "string",
  multiple: true,
  description: `${description}; повторяйте параметр`,
});
export const choice = (
  description: string,
  choices: string[],
  defaultValue?: string,
): ArgSchema => ({
  type: "enum",
  description,
  choices,
  ...(defaultValue === undefined ? {} : { default: defaultValue }),
});
export const integer = (
  description: string,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): ArgSchema => ({
  type: "custom",
  description,
  parse: (value) => {
    if (
      !/^\d+$/.test(value) ||
      !Number.isSafeInteger(Number(value)) ||
      Number(value) < min ||
      Number(value) > max
    ) {
      throw new Error(`ожидается целое число от ${min} до ${max}`);
    }
    return Number(value);
  },
});

export const revisionArgs: Args = {
  "if-revision": {
    ...integer("Прочитанная ревизия изменяемого владельца (обязательно)", 1),
    required: true,
  },
};
export const pageArgs: Args = {
  limit: { ...integer("Размер страницы (1–100)", 1, 100), default: 20 },
  cursor: string("Курсор продолжения того же запроса"),
};
export const refArgs: Args = { ref: positional("Ключ, алиас или постоянный ID") };

export function textArgs(...names: string[]): Args {
  return Object.fromEntries(
    names.flatMap((name) => [
      [name, string(`Содержание: ${name}`)],
      [`${name}-file`, string(`UTF-8 файл для ${name}; «-» читает stdin`)],
    ]),
  );
}
export function inputArgs(fields: Args, additionalFields: string[] = []): Args {
  const allowed = [
    ...Object.keys(fields)
      .filter((key) => !key.endsWith("-file"))
      .map(camelCase),
    ...additionalFields,
  ];
  return {
    input: {
      type: "custom",
      description: `JSON-объект полей (${allowed.join(", ")}); несовместим с отдельными полями`,
      parse: (text) => {
        const input = parseObject(text);
        onlyFields(input, allowed);
        return input;
      },
    },
    "input-file": string("JSON-файл полей; «-» читает stdin"),
    ...fields,
  };
}
export function jsonArgs(name: string, description: string): Args {
  return {
    [name]: { type: "custom", description, parse: (value) => JSON.parse(value) as unknown },
    [`${name}-file`]: string(`JSON-файл для ${name}; «-» читает stdin`),
  };
}

export function remapInput(
  input: Record<string, unknown>,
  aliases: Record<string, string>,
): Record<string, unknown> {
  const result = { ...input };
  for (const [source, target] of Object.entries(aliases)) {
    if (!Object.hasOwn(result, source)) continue;
    if (Object.hasOwn(result, target))
      throw new CliUsageError(`Поля ${source} и ${target} несовместимы`, "CONFLICTING_OPTIONS");
    result[target] = result[source];
    delete result[source];
  }
  return result;
}
export const camelCase = (name: string): string =>
  name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());

function parseObject(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CliUsageError("В --input ожидается корректный JSON", "INVALID_JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CliUsageError("В --input ожидается JSON-объект", "INVALID_JSON");
  }
  return value as Record<string, unknown>;
}

export async function readInput(
  values: Record<string, unknown>,
  fields: Args,
  runtime: CliRuntime,
): Promise<Record<string, unknown>> {
  const supplied = Object.keys(fields).filter((key) => values[key] !== undefined);
  const files = supplied.filter((key) => key.endsWith("-file"));
  // Проверяем все источники до первого чтения: два потребителя не должны ждать один stdin.
  if (files.filter((key) => values[key] === "-").length > 1) {
    throw new CliUsageError("stdin может использовать только одно поле", "CONFLICTING_OPTIONS");
  }
  for (const file of files) {
    if (values[file.slice(0, -5)] !== undefined) {
      throw new CliUsageError(
        `Параметры --${file.slice(0, -5)} и --${file} несовместимы`,
        "CONFLICTING_OPTIONS",
      );
    }
  }
  const wholeInput = values.input !== undefined || values["input-file"] !== undefined;
  if (wholeInput && supplied.some((key) => key !== "input" && key !== "input-file")) {
    throw new CliUsageError(
      "--input/--input-file нельзя смешивать с отдельными полями",
      "CONFLICTING_OPTIONS",
    );
  }
  const result: Record<string, unknown> = {};
  for (const key of supplied) {
    const field = key.endsWith("-file") ? key.slice(0, -5) : key;
    let value = values[key];
    if (key.endsWith("-file")) {
      try {
        value =
          value === "-"
            ? typeof runtime.stdin === "function"
              ? await runtime.stdin()
              : runtime.stdin
            : await readFile(resolve(runtime.cwd, String(value)), "utf8");
      } catch (error) {
        throw new CliUsageError(
          `Не удалось прочитать --${key}: ${error instanceof Error ? error.message : String(error)}`,
          "INPUT_READ_FAILED",
        );
      }
      if (typeof value === "string" && Buffer.byteLength(value, "utf8") > 128 * 1024 * 1024) {
        throw new CliUsageError(`Файл --${key} превышает 128 МиБ`, "INPUT_TOO_LARGE");
      }
      if (fields[field]?.type === "custom" && fields[field].parse) {
        try {
          value = fields[field].parse(String(value));
        } catch (error) {
          if (error instanceof CliUsageError) throw error;
          throw new CliUsageError(`В --${key} ожидается корректный JSON`, "INVALID_JSON");
        }
      }
    }
    if (field === "input") {
      // Gunshi уже проверяет inline JSON; файловый ввод проходит через ту же схему после чтения.
      return (typeof value === "string" ? fields.input!.parse!(value) : value) as Record<
        string,
        unknown
      >;
    }
    result[camelCase(field)] = value;
  }
  return result;
}

export function requiredText(input: Record<string, unknown>, name: string): string {
  const value = input[name];
  if (typeof value !== "string" || !value.trim())
    throw new CliUsageError(`Укажите непустое поле ${name}`);
  return value;
}

export function onlyFields(input: Record<string, unknown>, allowed: string[]): void {
  const unknown = Object.keys(input).find((key) => !allowed.includes(key));
  if (unknown) throw new CliUsageError(`Неизвестное поле: ${unknown}`);
}
