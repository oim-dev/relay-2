import i18n from "@gunshi/plugin-i18n";
import { define, plugin } from "gunshi";
import { version } from "../../package.json";
import { russianResources } from "../locales/ru";
import { programMessages } from "../locales/program";
import { choice, string } from "../input/arguments";
import { registerProjectCommands } from "../commands/project/register";
import { registerKnowledgeCommands } from "../commands/knowledge/register";
import { registerTaskCommands } from "../commands/tasks/register";
import { registerPlanningCommands } from "../commands/planning/register";
import { registerHistoryCommands } from "../commands/history/register";
import { registerQueryCommands } from "../commands/queries/register";
import { registerBatchCommands } from "../commands/batch/register";
import { registerGitSyncCommands } from "../commands/git-sync/register";
import { checkPositionals, CommandRegistry } from "../execution/registry";
import { createHelpRenderer } from "../output/help";
import { processRuntime } from "../execution/runtime";
import type { CliRuntime } from "../execution/runtime.types";
import type { CliProgram, CliProgramOptions } from "./program.types";
import { parseExpectedAddresses } from "../input/expected-addresses";

/**
 * Создаёт независимые дерево команд и плагины Gunshi для одного запуска.
 * Регистрация не выбирает проект, не открывает БД и не читает stdin: справка работает автономно.
 */
export function createProgram(runtime: CliRuntime = processRuntime()): CliProgram {
  const registry = new CommandRegistry(runtime);
  for (const register of [
    registerProjectCommands,
    registerKnowledgeCommands,
    registerTaskCommands,
    registerPlanningCommands,
    registerHistoryCommands,
    registerQueryCommands,
    registerBatchCommands,
    registerGitSyncCommands,
  ]) {
    register(registry);
  }
  const renderHelp = createHelpRenderer(programMessages.help);
  const command = define({
    name: "relay",
    description: programMessages.help.description,
    run: renderHelp,
  });

  const options = {
    name: "relay",
    description: programMessages.header,
    version,
    subCommands: registry.commands,
    strict: true,
    fallbackToEntry: false,
    usageSilent: true,
    renderHeader: null,
    renderUsage: renderHelp,
    plugins: [
      i18n({ locale: "ru-RU", builtinResources: { "ru-RU": russianResources } }),
      plugin({
        id: "relay:globals",
        /**
         * Добавляет глобальные параметры только в контекст текущего экземпляра Gunshi.
         */
        setup(ctx): void {
          ctx.addGlobalOption("config", string(programMessages.config));
          ctx.addGlobalOption("project", string(programMessages.project));
          ctx.addGlobalOption("actor", string(programMessages.actor));
          ctx.addGlobalOption("expected-addresses", {
            type: "custom",
            description: programMessages.expectedAddresses,
            parse: parseExpectedAddresses,
          });
          ctx.addGlobalOption("format", choice(programMessages.format, ["text", "json"], "text"));
        },
      }),
    ],
    /**
     * Проверяет синтаксис и условные write-предусловия до открытия источников ввода.
     */
    onBeforeCommand(context): void {
      checkPositionals(context);
      registry.checkWritePreconditions(context);
    },
  } satisfies CliProgramOptions;

  return { command, options, outcome: registry.outcome };
}
