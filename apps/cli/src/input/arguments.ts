import type { Args, ArgSchema } from "gunshi";
import { camelCase, onlyFields, parseInputObject } from "./input";
import { argumentMessages } from "../locales/arguments";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MIN_PAGE_SIZE,
} from "../pagination/pagination.constants";
import type { InputFields } from "./arguments.types";
import { CliUsageError } from "../errors/errors";

/**
 * Описывает строковый параметр; обязательность проверяет Gunshi до выполнения команды.
 */
export function string(description: string, required = false): ArgSchema {
  return {
    type: "string",
    description: required ? argumentMessages.required(description) : description,
    required,
  };
}

/**
 * Описывает позиционный аргумент, обязательный по умолчанию.
 */
export function positional(description: string, required = true): ArgSchema {
  return { type: "positional", description, required };
}

/**
 * Описывает логический параметр с сохранением явно переданного false.
 */
export function flag(description: string): ArgSchema {
  return { type: "boolean", description };
}

/**
 * Описывает повторяемый строковый параметр, значения которого Gunshi собирает в массив.
 */
export function repeated(description: string): ArgSchema {
  return { type: "string", multiple: true, description: argumentMessages.repeated(description) };
}

/**
 * Описывает выбор из заданного набора; отсутствие defaultValue оставляет параметр необязательным.
 */
export function choice(
  description: string,
  choices: readonly string[],
  defaultValue?: string,
): ArgSchema {
  return {
    type: "enum",
    description,
    choices: [...choices],
    ...(defaultValue === undefined ? {} : { default: defaultValue }),
  };
}

/**
 * Описывает десятичное целое число в включительных границах безопасных чисел JavaScript.
 * Знак, дробная часть и экспоненциальная запись отвергаются при разборе аргументов.
 */
export function integer(
  description: string,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): ArgSchema {
  return {
    type: "custom",
    description,
    /**
     * Проверяет синтаксис и диапазон до преобразования значения для обработчика команды.
     */
    parse: (value: string): number => {
      const parsed = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
        throw new Error(argumentMessages.integerRange(min, max));
      }
      return parsed;
    },
  };
}

/**
 * Принимает непрозрачный токен дословно; пустая строка не является переносимым предусловием.
 */
export function versionToken(description: string, name = "expected-version"): ArgSchema {
  return {
    type: "custom",
    description,
    /**
     * Проверяет только непустоту, не интерпретируя формат или содержимое token.
     */
    parse: (value: string): string => {
      if (!value.trim()) {
        throw new CliUsageError(argumentMessages.invalidVersionToken(name));
      }
      return value;
    },
  };
}

export const expectedVersionArgs: Args = {
  "expected-version": versionToken(argumentMessages.expectedVersion),
};
export const revisionArgs: Args = {
  "if-revision": integer(argumentMessages.revision, 1),
  ...expectedVersionArgs,
};
export const pageArgs: Args = {
  limit: {
    ...integer(argumentMessages.pageSize, MIN_PAGE_SIZE, MAX_PAGE_SIZE),
    default: DEFAULT_PAGE_SIZE,
  },
  cursor: string(argumentMessages.cursor),
};
export const refArgs: Args = { ref: positional(argumentMessages.reference) };

/**
 * Создаёт пары источников с предметным описанием каждого текста; совместимость проверяется до stdin.
 */
export function textArgs(fields: Readonly<Record<string, string>>): Args {
  return Object.fromEntries(
    Object.entries(fields).flatMap(([name, description]) => [
      [name, string(description)],
      [`${name}-file`, string(argumentMessages.textFile(name))],
    ]),
  );
}

/**
 * Добавляет цельный JSON-ввод к полям команды и проверяет разрешённые имена верхнего уровня.
 * Предметные значения остаются входной границей Core; additionalFields разрешает его имена-алиасы.
 */
export function inputArgs(fields: Args, additionalFields: readonly string[] = []): Args {
  const allowed = [
    ...Object.keys(fields)
      .filter((key) => !key.endsWith("-file"))
      .map(camelCase),
    ...additionalFields,
  ];
  return {
    input: {
      type: "custom",
      description: argumentMessages.input(allowed),
      /**
       * Проверяет форму JSON-объекта и известные имена полей для обоих источников ввода.
       */
      parse: (text: string): InputFields => {
        const input = parseInputObject(text);
        onlyFields(input, allowed);
        return input;
      },
    },
    "input-file": string(argumentMessages.inputFile),
    ...fields,
  };
}

/**
 * Создаёт inline- и файловый JSON-источники одного поля без проверки его предметной формы.
 */
export function jsonArgs(name: string, description: string): Args {
  return {
    [name]: {
      type: "custom",
      description,
      /**
       * Декодирует внешний JSON; проверка структуры конкретного поля принадлежит Core.
       */
      parse: (value: string): unknown => JSON.parse(value),
    },
    [`${name}-file`]: string(argumentMessages.jsonFile(name)),
  };
}
