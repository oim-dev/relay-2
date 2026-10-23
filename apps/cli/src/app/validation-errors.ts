import {
  ArgsValidationError,
  ArgsValidationErrorKeys,
  isArgsValidationError,
  type CommandContext,
} from "gunshi";
import { renderValidationErrors } from "gunshi/renderer";
import { errorMessages } from "../locales/errors";

/**
 * Находит отдельные dash-leading слова с пробелами после строковых параметров без значения.
 * Использует исходные индексы токенов и уже полученные ошибки Gunshi; argv не переписывается.
 * Обычные неизвестные флаги без пробелов и слова после -- остаются штатной диагностикой.
 */
function dashValueOptions(
  context: Readonly<CommandContext>,
  errors: readonly unknown[],
): Map<number, string> {
  const missing = new Set<string>();
  for (const error of errors) {
    if (
      isArgsValidationError(error) &&
      error.code === ArgsValidationErrorKeys.missingValue &&
      typeof error.values.name === "string" &&
      context.args[error.values.name]?.type === "string"
    ) {
      missing.add(`--${error.values.name}`);
    }
  }
  const options = new Set(
    context.tokens.filter((token) => token.kind === "option").map((token) => token.index),
  );
  const result = new Map<number, string>();
  for (const [index, word] of context._.entries()) {
    const previous = context._[index - 1];
    if (
      previous !== undefined &&
      missing.has(previous) &&
      options.has(index) &&
      word.startsWith("-") &&
      /\s/u.test(word)
    ) {
      result.set(index, previous.slice(2));
    }
  }
  return result;
}

/**
 * Группирует только производные unknown-option одного текстового argv после штатной валидации.
 * Исходная AggregateError сохраняется у Gunshi: help/version не обходят приоритет неизвестных
 * параметров. Другие ошибки и отдельные неизвестные флаги сохраняют локализацию и порядок.
 * Текст значения не печатается: длинный Markdown не раздувает ни сообщение, ни подсказку.
 */
export async function renderCliValidationErrors(
  context: Readonly<CommandContext>,
  error: AggregateError,
): Promise<string> {
  const errors: readonly unknown[] = error.errors;
  const dashValues = dashValueOptions(context, errors);
  if (dashValues.size === 0) {
    return renderValidationErrors(context, error);
  }
  const names = new Set(dashValues.values());
  const indices = new Map<string, number[]>();
  for (const token of context.tokens.toReversed()) {
    if (token.kind === "option" && token.rawName) {
      const occurrences = indices.get(token.rawName) ?? [];
      occurrences.push(token.index);
      indices.set(token.rawName, occurrences);
    }
  }
  const emitted = new Set<number>();
  const diagnostics: unknown[] = [];
  for (const item of errors) {
    if (isArgsValidationError(item)) {
      if (
        item.code === ArgsValidationErrorKeys.missingValue &&
        names.has(String(item.values.name))
      ) {
        const values = { ...item.values };
        delete values.next;
        delete values.suggestion;
        diagnostics.push(new ArgsValidationError(item.message, { code: item.code, values }));
        continue;
      }
      if (
        item.code === ArgsValidationErrorKeys.unknownOption &&
        typeof item.values.rawName === "string"
      ) {
        const index = indices.get(item.values.rawName)?.pop();
        const name = index === undefined ? undefined : dashValues.get(index);
        if (index !== undefined && name !== undefined) {
          if (!emitted.has(index)) {
            diagnostics.push(new Error(errorMessages.dashValue(name)));
            emitted.add(index);
          }
          continue;
        }
      }
    }
    diagnostics.push(item);
  }
  return renderValidationErrors(context, new AggregateError(diagnostics));
}
