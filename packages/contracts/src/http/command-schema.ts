import { historyCommandInputs } from "./command-schema-history";
import { knowledgeCommandInputs } from "./command-schema-knowledge";
import { planningCommandInputs } from "./command-schema-planning";
import { taskCommandInputs } from "./command-schema-tasks";
import type { CommandJsonSchema } from "./command-schema.types";

/**
 * Точные формы input опубликованных команд. Генератор обязан сверять полноту,
 * поля и позиции локальных ссылок с текущим BATCH_OPERATIONS Core.
 * Эти декларации не используются вместо предметных parsers/loaders/calculators.
 */
export const HTTP_COMMAND_INPUT_SCHEMAS: Readonly<Record<string, CommandJsonSchema>> = {
  ...knowledgeCommandInputs,
  ...taskCommandInputs,
  ...planningCommandInputs,
  ...historyCommandInputs,
};

/**
 * Самодостаточные примеры каждого семейства для нового проекта. История использует
 * только start: дальнейшие действия получают настоящий runId из квитанции/чтения.
 */
export const HTTP_COMMAND_EXAMPLES = {
  knowledge: {
    actor: "Разработчик",
    operationKey: "example-knowledge",
    commands: [
      { op: "feature.create", as: "feature", input: { name: "Поиск" } },
      { op: "scenario.create", input: { name: "Поиск по названию", feature: { $ref: "feature" } } },
      {
        op: "document.create",
        input: {
          name: "Правила поиска",
          body: "Ищем по названию.",
          targets: [{ $ref: "feature" }],
        },
      },
    ],
  },
  tasks: {
    actor: "Разработчик",
    operationKey: "example-tasks",
    commands: [
      { op: "task.create", as: "task", input: { title: "Добавить поиск" } },
      {
        op: "task.criterion.add",
        ref: { $ref: "task" },
        ifRevision: { $revision: "task" },
        input: { title: "Находит по названию" },
      },
      { op: "task.comment.add", ref: { $ref: "task" }, input: { body: "Начинаю работу" } },
    ],
  },
  planning: {
    actor: "Разработчик",
    operationKey: "example-planning",
    commands: [
      { op: "plan.create", as: "plan", input: { title: "Поиск" } },
      {
        op: "plan.stage.create",
        ref: { $ref: "plan" },
        ifRevision: { $revision: "plan" },
        input: { title: "Реализация" },
      },
      {
        op: "release.create",
        input: { title: "Поиск", version: "1.0", planIds: [{ $ref: "plan" }] },
      },
    ],
  },
  history: {
    actor: "Разработчик",
    operationKey: "example-history",
    commands: [{ op: "session.start", input: { title: "Добавить поиск", operator: null } }],
  },
} as const;
