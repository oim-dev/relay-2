import type { Args } from "gunshi";
import type {
  CompletionConfig,
  CompletionHandler,
  CompletionOptions,
} from "@gunshi/plugin-completion";
import type { RegistryCommand } from "../execution/registry.types";

/**
 * Строит обработчики значений enum из той же схемы, которой пользуется парсер.
 * Строковые поля и позиционные ссылки не получают вымышленных кандидатов.
 */
function enumCompletions(args: Args): CompletionConfig {
  const handlers: NonNullable<CompletionConfig["args"]> = {};
  for (const [key, schema] of Object.entries(args)) {
    const choices = schema.choices;
    if (schema.type === "enum" && choices && !schema.hidden) {
      handlers[key] = {
        /**
         * Возвращает новый массив допустимых значений без обращения к проекту.
         */
        handler: (): ReturnType<CompletionHandler> =>
          choices.map((value) => ({ value: String(value) })),
      };
    }
  }
  return { args: handlers };
}

/**
 * Обходит дерево определений, не запуская обработчики; дочерние аргументы перекрывают глобальные.
 */
function collectCommands(
  commands: ReadonlyMap<string, RegistryCommand>,
  globals: Args,
  result: Record<string, CompletionConfig>,
  prefix: readonly string[],
): void {
  for (const [name, command] of commands) {
    const path = [...prefix, name];
    result[path.join(" ")] = enumCompletions({ ...globals, ...command.args });
    collectCommands(command.subCommands, globals, result, path);
  }
}

/**
 * Создаёт конфигурацию значений только для запроса completion: O(число команд и аргументов).
 * Имена команд и флагов обрабатывает Gunshi; здесь дополняются только значения перечислений.
 */
export function completionCandidates(
  commands: ReadonlyMap<string, RegistryCommand>,
  globals: Args,
  entryArgs: Args = {},
): NonNullable<CompletionOptions["config"]> {
  const subCommands: Record<string, CompletionConfig> = {};
  collectCommands(commands, globals, subCommands, []);
  return { entry: enumCompletions({ ...globals, ...entryArgs }), subCommands };
}
