import type { CommandContext } from "gunshi";
import { renderUsage } from "gunshi/renderer";
import { helpMessages } from "../locales/help";
import type { CommandHelp, HelpRenderer, HelpRendererOptions } from "./help.types";

/**
 * Сохраняет полный путь вложенной группы в usage Gunshi и в ссылках на дочернюю справку.
 * При omitted штатный renderer считает env.name корнем текущего списка команд.
 */
function usageContext(context: Readonly<CommandContext>): Readonly<CommandContext> {
  if (!context.omitted || context.commandPath.length === 0) {
    return context;
  }
  return {
    ...context,
    commandPath: [],
    env: { ...context.env, name: [context.env.name, ...context.commandPath].join(" ") },
  };
}

/**
 * Убирает только технический символ собственного entry из списка команд справочного узла.
 * Gunshi добавляет его даже узлу без действия; обычные группы сохраняют прежнее представление.
 */
function withoutEntryRow(usage: string, context: Readonly<CommandContext>): string {
  const symbol = `[${context.name}]`;
  return usage
    .split("\n")
    .filter((line) => {
      const text = line.trimStart();
      return text !== symbol && !text.startsWith(`${symbol} `);
    })
    .join("\n");
}

/**
 * Связывает пояснения с одной командой; параметры и их значения рисует штатный Gunshi.
 * В строках параметров исправляет скобки default-значений: сам флаг необязателен,
 * но его явно переданное значение обязательно. Позиционные аргументы сохраняют свою нотацию.
 * Примеры дописываются без построчного отступа: он менял бы Markdown внутри shell-кавычек.
 * Renderer не создаёт Invocation, не выбирает проект и не читает stdin.
 */
export function createHelpRenderer(
  help: CommandHelp,
  options: HelpRendererOptions = {},
): HelpRenderer {
  /**
   * Возвращает справку выбранной команды с единственным описанием и копируемыми примерами.
   */
  return async (context): Promise<string> => {
    let usage = (await renderUsage(usageContext(context))).replace(
      /^([ \t]+(?:-\S, )?--\S+ )\[([^\]\n]+)\](?=[ \t]|$)/gm,
      "$1<$2>",
    );
    if (options.entryRow === false && context.omitted) {
      usage = withoutEntryRow(usage, context);
    }
    const examples = help.examples.map(
      (example) => `  # ${example.description}\n  ${example.command}`,
    );
    return [
      ...(context.callMode === "subCommand" ? [] : [help.description]),
      usage.trimEnd(),
      `${helpMessages.details}\n${help.details}`,
      helpMessages.exampleValues,
      `${helpMessages.examples}\n${examples.join("\n\n")}`,
    ].join("\n\n");
  };
}
