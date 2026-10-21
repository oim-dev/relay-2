import completion, { pluginId, type CompletionOptions } from "@gunshi/plugin-completion";
import { plugin, type CommandContext } from "gunshi";
import { CliUsageError } from "../errors/errors";
import { renderHelp } from "../execution/registry";
import { positional } from "../input/arguments";
import { completionMessages as messages } from "../locales/completion";
import { bashCompletionScript } from "./completion-bash";
import { completionCandidates } from "./completion-candidates";
import { completionShells } from "./completion.constants";
import type { CompletionRequest, CompletionShell } from "./completion.types";
import type { CliProgram } from "./program.types";

const assignedValueSlot = "__relay_completion_assigned_value__";

/**
 * Распознаёт поддерживаемую оболочку без приведения пользовательской строки к контракту.
 */
function isCompletionShell(value: string): value is CompletionShell {
  return completionShells.some((shell) => shell === value);
}

/**
 * Различает генерацию скрипта и протокольный запрос; слова после -- остаются непрозрачными.
 * Ошибочный shell и лишние аргументы отклоняются до записи скрипта в stdout.
 */
function completionRequest(context: Readonly<CommandContext>): CompletionRequest {
  const positionals = context.positionals.slice(context.commandPath.length);
  if (context._.includes("--")) {
    if (positionals.length) {
      throw new CliUsageError(messages.invalidRequest);
    }
    return { kind: "query", words: context.rest };
  }
  if (positionals.length === 0) {
    return { kind: "help" };
  }
  const shell = positionals[0];
  if (positionals.length !== 1 || shell === undefined) {
    throw new CliUsageError(messages.invalidRequest);
  }
  if (!isCompletionShell(shell)) {
    throw new CliUsageError(messages.unsupportedShell(shell, completionShells));
  }
  return { kind: "script", shell };
}

/**
 * Компенсирует разбор завершённых --option=value в Gunshi/Tab: тот ожидает ещё одно слово значения.
 * Непрозрачный слот поглощается парсером вместо следующей команды. Исходные слова и значения
 * сохраняются целиком; текущее слово под курсором и слова после разделителя -- не меняются.
 * Массив используется только для подсказок, никогда для выполнения предметных команд.
 */
function completionWords(words: readonly string[]): string[] {
  const result: string[] = [];
  let options = true;
  for (const [index, word] of words.entries()) {
    result.push(word);
    if (word === "--") {
      options = false;
    } else if (options && index < words.length - 1 && word.startsWith("--") && word.includes("=")) {
      result.push(assignedValueSlot);
    }
  }
  return result;
}

/**
 * Подключает официальный плагин только к процессному запуску и локализует его команду.
 * Нативный вывод плагина не попадает в изолированный runCli. Дерево enum строится лениво,
 * только при запросе кандидатов; обычные команды сохраняют прежнюю проверку positionals.
 */
export function enableCompletion(program: CliProgram): void {
  const config: NonNullable<CompletionOptions["config"]> = {};
  const beforeCommand = program.options.onBeforeCommand;
  /**
   * Проверяет служебный протокол отдельно, сохраняя строгий разбор обычных команд.
   */
  program.options.onBeforeCommand = (context): void => {
    if (context.commandPath.length === 1 && context.commandPath[0] === "complete") {
      if (!context.validationError) {
        completionRequest(context);
      }
    } else {
      beforeCommand(context);
    }
  };
  program.options.plugins = [
    ...(program.options.plugins ?? []),
    completion({ config }),
    plugin({
      id: "relay:completion",
      dependencies: [pluginId, "relay:globals"],
      /**
       * Настраивает определение, принадлежащее одному экземпляру Gunshi, после официального плагина.
       */
      setup(ctx): void {
        const command = ctx.subCommands.get("complete");
        if (!command || typeof command === "function" || !command.run) {
          throw new Error(messages.missingCommand);
        }
        const nativeRun = command.run;
        command.description = messages.description;
        command.examples = messages.examples;
        command.args = { shell: positional(messages.shell, false) };
        /**
         * Печатает shell-скрипт или передаёт проверенные слова официальному протоколу кандидатов.
         * Нормализация argv сохраняет глобальные параметры перед complete и пустое слово под курсором.
         */
        command.run = async (context): Promise<void | string> => {
          const request = completionRequest(context);
          if (request.kind === "help") {
            return renderHelp(context);
          }
          if (request.kind === "script") {
            if (request.shell === "bash") {
              return bashCompletionScript;
            }
            return nativeRun({ ...context, _: ["complete", request.shell] });
          }
          Object.assign(
            config,
            completionCandidates(
              program.options.subCommands,
              Object.fromEntries(ctx.globalOptions),
              program.command.args,
            ),
          );
          return nativeRun({
            ...context,
            _: ["complete", "--", ...completionWords(request.words)],
          });
        };
      },
    }),
  ];
}
