import type { CliOptions, Command, CommandContext } from "gunshi";
import type { CommandOutcome, RegistryCommand } from "../execution/registry.types";

/**
 * Конфигурация Gunshi с обязательными частями, на которые опирается встраиваемый runCli.
 */
export interface CliProgramOptions extends CliOptions {
  /* Изолированное дерево корневых команд текущего запуска. */
  subCommands: Map<string, RegistryCommand>;

  /**
   * Проверяет оставшиеся позиционные аргументы до вызова предметного обработчика.
   */
  onBeforeCommand(context: Readonly<CommandContext>): void;
}

/**
 * Независимая программа Gunshi для одного вызова; не хранит открытого соединения БД.
 */
export interface CliProgram {
  /* Корневая команда, показывающая справку при пустом вызове. */
  readonly command: Command;
  /* Настройки, глобальные параметры и плагины только текущего запуска. */
  readonly options: CliProgramOptions;
  /* Исход предметного действия; позволяет сохранить частичный stdout с ненулевым exit code. */
  readonly outcome: CommandOutcome;
}
