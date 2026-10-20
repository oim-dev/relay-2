import i18n from "@gunshi/plugin-i18n";
import { define, plugin, type CliOptions } from "gunshi";
import { version } from "../package.json";
import { russianResources } from "./locales/ru";
import { choice, string } from "./arguments";
import { registerProjectCommands } from "./commands/project";
import { registerKnowledgeCommands } from "./commands/knowledge";
import { registerTaskCommands } from "./commands/tasks";
import { registerPlanningCommands } from "./commands/planning";
import { registerHistoryCommands } from "./commands/history";
import { registerQueryCommands } from "./commands/queries";
import { checkPositionals, CommandRegistry, renderHelp } from "./registry";
import { processRuntime, type CliRuntime } from "./runtime";

export function createProgram(runtime: CliRuntime = processRuntime()) {
  const registry = new CommandRegistry(runtime);
  for (const register of [
    registerProjectCommands,
    registerKnowledgeCommands,
    registerTaskCommands,
    registerPlanningCommands,
    registerHistoryCommands,
    registerQueryCommands,
  ])
    register(registry);
  const command = define({
    name: "relay",
    description: "Рабочая память проекта для людей и AI-агентов",
    examples: "relay init --name 'Мой проект'\nrelay task list\nrelay --help\nrelay --version",
    run: renderHelp,
  });

  const options = {
    name: "relay",
    description: "Relay — рабочая память проекта для людей и AI-агентов",
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
        setup(ctx) {
          ctx.addGlobalOption("config", string("Путь к конфигурации проекта или workspace"));
          ctx.addGlobalOption("project", string("Имя регистрации workspace"));
          ctx.addGlobalOption("actor", string("Автор записи; иначе RELAY_ACTOR"));
          ctx.addGlobalOption(
            "format",
            choice("Вывод: text для чтения, json для скриптов", ["text", "json"], "text"),
          );
        },
      }),
    ],
    onBeforeCommand: checkPositionals,
  } satisfies CliOptions;

  return { command, options };
}
