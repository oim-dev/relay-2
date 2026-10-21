import { define, type CommandContext } from "gunshi";
import { renderUsage } from "gunshi/renderer";
import { revisionArgs } from "../input/arguments";
import { readInput } from "../input/input";
import { CliUsageError } from "../errors/errors";
import { Invocation } from "./invocation";
import { registryMessages } from "../locales/registry";
import { renderResult } from "../output/output";
import type { Result } from "../output/output.types";
import type { Action, RegistryCommand } from "./registry.types";
import type { CliRuntime } from "./runtime.types";

/**
 * Строит справку выбранной команды без создания Invocation, чтения stdin и выбора проекта.
 */
export async function renderHelp(ctx: Readonly<CommandContext>): Promise<string> {
  return `${ctx.description ?? ctx.env.description}\n\n${await renderUsage(ctx)}`;
}

/**
 * Выполняет синхронный сценарий в общей транзакции записи либо согласованном снимке чтения.
 * Локальные действия сами владеют ресурсами; проверка автора предшествует открытию БД.
 */
function runAction(action: Action<Invocation>, invocation: Invocation): Result {
  if (action.mode) {
    void invocation.actor;
  }
  if (action.local) {
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
  /* Явное окружение, используемое всеми обработчиками данного дерева. */
  private readonly runtime: CliRuntime;

  /**
   * Создаёт пустой реестр без доступа к проекту и стандартному вводу.
   */
  constructor(runtime: CliRuntime) {
    this.runtime = runtime;
  }

  /**
   * Создаёт промежуточный путь при необходимости и назначает описание группы для справки.
   */
  group(path: string, description: string): void {
    this.node(path).description = description;
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
        args: {
          ...action.args,
          ...action.fields,
          ...(action.mode === "update" ? revisionArgs : {}),
        },
        /**
         * Читает ввод, выполняет сценарий и форматирует ответ, гарантируя освобождение БД при отказе.
         */
        run: async (context: Readonly<CommandContext>): Promise<string> => {
          const input = await readInput(context.values, action.fields ?? {}, this.runtime);
          const invocation = new Invocation(context, this.runtime, input);
          try {
            return renderResult(runAction(action, invocation), invocation.text("format") || "text");
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
        command = { name, description: name, run: renderHelp, subCommands: new Map() };
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
  const count = Object.values(ctx.args).filter((schema) => schema.type === "positional").length;
  const extra = ctx.positionals[ctx.commandPath.length + count] ?? ctx.rest[0];
  if (extra !== undefined) {
    throw new CliUsageError(
      count === 0 ? registryMessages.unknownCommand(extra) : registryMessages.extraArgument(extra),
    );
  }
}
