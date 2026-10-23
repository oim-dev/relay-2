import { define, type CommandContext } from "gunshi";
import { renderUsage } from "gunshi/renderer";
import { revisionArgs } from "../input/arguments";
import { readInput } from "../input/input";
import { CliUsageError } from "../errors/errors";
import { Invocation } from "./invocation";
import { registryMessages } from "../locales/registry";
import { renderResult } from "../output/output";
import { createHelpRenderer } from "../output/help";
import type { CommandHelp, HelpRenderer } from "../output/help.types";
import type { Result } from "../output/output.types";
import type { Action, CommandOutcome, RegistryCommand } from "./registry.types";
import type { CliRuntime } from "./runtime.types";

/**
 * Выполняет синхронный сценарий в общей транзакции записи либо согласованном снимке чтения.
 * Локальные действия сами владеют ресурсами; service оставляет транзакцию сервису Core.
 * Проверка автора предшествует открытию БД в любом режиме записи.
 */
function runAction(action: Action<Invocation>, invocation: Invocation): Result {
  if (action.mode) {
    void invocation.actor;
  }
  if (action.local || action.execution === "service") {
    return action.run(invocation);
  }
  if (action.mode) {
    return invocation.db.transaction(() => action.run(invocation));
  }
  // Снимок связывает страницу с поколением, не резервируя блокировку писателя для чтения.
  return invocation.db.snapshot(() => action.run(invocation));
}

/**
 * Собирает дерево команд одного запуска и связывает обработчики с жизненным циклом ресурсов.
 * Экземпляры и плагины не разделяются между параллельными runCli.
 */
export class CommandRegistry {
  /* Корневые узлы в порядке регистрации; дерево принадлежит только текущему запуску. */
  readonly commands = new Map<string, RegistryCommand>();
  /* Исход текущего действия для границы потоков; метаданные не попадают в предметный JSON. */
  readonly outcome: CommandOutcome = {};
  /* Явное окружение, используемое всеми обработчиками данного дерева. */
  private readonly runtime: CliRuntime;

  /**
   * Создаёт пустой реестр без доступа к проекту и стандартному вводу.
   */
  constructor(runtime: CliRuntime) {
    this.runtime = runtime;
  }

  /**
   * Назначает группе автономную справку, общую для --help и вызова без подкоманды.
   */
  group(path: string, help: CommandHelp): void {
    const node = this.node(path);
    const render = createHelpRenderer(help);
    node.description = help.description;
    node.rendering = { usage: render };
    node.run = render;
  }

  /**
   * Регистрирует справочный узел без вычисления подробностей до его bare-вызова либо --help.
   * Фабрика принадлежит команде; общий реестр не читает проект и не запускает её предметный сценарий.
   * Один renderer обслуживает обе формы, поэтому лист без подкоманд тоже остаётся справкой.
   */
  groupLazy(path: string, description: string, factory: () => CommandHelp): void {
    const node = this.node(path);
    /**
     * Формирует только выбранную справку; результат и фабрика не кешируются между вызовами.
     */
    const render: HelpRenderer = (context) =>
      createHelpRenderer(factory(), { entryRow: false })(context);
    node.description = description;
    node.rendering = { usage: render };
    node.run = render;
  }

  /**
   * Регистрирует обработчик один раз, добавляя обязательную ревизию только update-действиям.
   * Ввод читается до открытия БД; любое завершение обработчика закрывает соединение в finally.
   */
  add(path: string, action: Action<Invocation>): void {
    const node = this.node(path);
    if (node.args) {
      throw new Error(registryMessages.duplicateRegistration(path));
    }
    Object.assign(
      node,
      define({
        name: node.name,
        description: action.description,
        rendering: { usage: createHelpRenderer(action) },
        args: {
          ...action.args,
          ...action.fields,
          ...(action.mode === "update" ? revisionArgs : {}),
        },
        /**
         * Читает ввод, выполняет сценарий и форматирует ответ, гарантируя освобождение БД при отказе.
         */
        run: async (context: Readonly<CommandContext>): Promise<string> => {
          const input = action.readInput
            ? await action.readInput(context.values, this.runtime)
            : await readInput(context.values, action.fields ?? {}, this.runtime);
          const invocation = new Invocation(context, this.runtime, input);
          try {
            const result = runAction(action, invocation);
            if (result.failure) {
              this.outcome.failure = result.failure;
            } else {
              delete this.outcome.failure;
            }
            return renderResult(result, invocation.text("format") || "text", action.presentation);
          } finally {
            invocation.close();
          }
        },
      }),
    );
  }

  /**
   * Находит или создаёт узлы пути; промежуточные группы по умолчанию показывают справку.
   * Все узлы имеют Map дочерних команд, поэтому обход не требует утверждений типов Gunshi.
   */
  private node(path: string): RegistryCommand {
    let commands = this.commands;
    let command: RegistryCommand | undefined;
    for (const name of path.split(" ")) {
      command = commands.get(name);
      if (!command) {
        command = { name, description: name, run: renderUsage, subCommands: new Map() };
        commands.set(name, command);
      }
      commands = command.subCommands;
    }
    if (!command) {
      throw new Error(registryMessages.emptyCommandPath);
    }
    return command;
  }
}

/**
 * Отклоняет неизвестную команду или лишний позиционный аргумент до запуска обработчика.
 * При собственной ошибке валидации Gunshi сохраняет её исходную диагностику.
 */
export function checkPositionals(ctx: Readonly<CommandContext>): void {
  if (ctx.validationError) {
    return;
  }
  const positionals = Object.values(ctx.args).filter((schema) => schema.type === "positional");
  if (positionals.some((schema) => schema.multiple)) {
    return;
  }
  const count = positionals.length;
  const extra = ctx.positionals[ctx.commandPath.length + count] ?? ctx.rest[0];
  if (extra !== undefined) {
    throw new CliUsageError(
      count === 0 ? registryMessages.unknownCommand(extra) : registryMessages.extraArgument(extra),
    );
  }
}
