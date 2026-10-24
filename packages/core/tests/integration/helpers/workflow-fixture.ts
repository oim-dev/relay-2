import type { NamedCommand } from "@relay/contracts";

/**
 * Описывает атомарную подготовку того же состава знаний, задач и планирования,
 * что последовательная workflow fixture. Все зависимости передаются локальными
 * ссылками; операции не выполняются до вызова настоящего BatchService.
 */
export function workflowCommands(): readonly NamedCommand[] {
  return [
    { op: "feature.create", as: "feature", input: { name: "Локальный экспорт" } },
    {
      op: "scenario.create",
      as: "scenario",
      input: { name: "Сохранить выбранные данные", feature: { $ref: "feature" } },
    },
    {
      op: "application.create",
      as: "application",
      input: { name: "Консольный клиент", slug: "console", prefix: "CONSOLE", type: "internal" },
    },
    {
      op: "implementation.create",
      as: "fi",
      ifRevision: { $revision: "application" },
      input: {
        application: { $ref: "application" },
        target: { $ref: "feature" },
        title: "Команды экспорта",
      },
    },
    {
      op: "implementation.create",
      as: "si",
      ifRevision: { $revision: "fi" },
      input: {
        application: { $ref: "application" },
        target: { $ref: "scenario" },
        title: "Запись выбранных данных",
      },
    },
    {
      op: "task.create",
      as: "preparation",
      input: { board: "console", title: "Подготовить файловый адаптер" },
    },
    {
      op: "task.create",
      as: "implementation",
      input: {
        board: "console",
        title: "Реализовать команду экспорта",
        targets: [{ $ref: "fi" }, { $ref: "si" }],
        dependencies: [{ $ref: "preparation" }],
      },
    },
    {
      op: "task.criterion.add",
      as: "criterion",
      ref: { $ref: "implementation" },
      ifRevision: { $revision: "implementation" },
      input: { title: "Выбранные данные записываются без потерь" },
    },
    {
      op: "task.create",
      as: "acceptance",
      input: {
        title: "Принять пользовательский сценарий",
        targets: [{ $ref: "scenario" }],
        dependencies: [{ $ref: "implementation" }],
      },
    },
    {
      op: "plan.create",
      as: "plan",
      input: {
        title: "Локальный экспорт через CLI",
        goal: "Дать пользователю сохранение выбранных данных без сервера.",
        scope: [
          { kind: "feature", id: { $ref: "feature" } },
          { kind: "application", id: { $ref: "application" } },
          { kind: "implementation", id: { $ref: "si" } },
        ],
      },
    },
    {
      op: "plan.stage.create",
      as: "stage",
      ref: { $ref: "plan" },
      ifRevision: { $revision: "plan" },
      input: { title: "Реализация и приёмка" },
    },
    {
      op: "plan.stage.task.add",
      as: "implementation-membership",
      ref: { $ref: "plan" },
      ifRevision: { $revision: "stage" },
      input: { stageId: { $ref: "stage" }, task: { $ref: "implementation" } },
    },
    {
      op: "plan.stage.task.add",
      as: "acceptance-membership",
      ref: { $ref: "plan" },
      ifRevision: { $revision: "implementation-membership" },
      input: { stageId: { $ref: "stage" }, task: { $ref: "acceptance" } },
    },
    {
      op: "release.create",
      input: { title: "Первый локальный экспорт", version: "1.0.0", planIds: [{ $ref: "plan" }] },
    },
  ];
}
