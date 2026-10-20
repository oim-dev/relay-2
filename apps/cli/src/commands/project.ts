import { readFileSync } from "node:fs";
import {
  initializeProject,
  initializeWorkspace,
  listProjects,
  registerProject,
  resolveProject,
  unregisterProject,
} from "@relay/project-runtime";
import { pageArgs, positional, string, textArgs } from "../arguments";
import { fingerprint } from "../pagination";
import { type CommandRegistry, type Invocation, result } from "../registry";

export function registerProjectCommands(registry: CommandRegistry): void {
  registry.add("init", {
    description: "Создать локальный проект и SQLite-базу",
    local: true,
    fields: { ...textArgs("name"), slug: string("Slug проекта") },
    run: (i) => result(initializeProject({ ...i.options, ...i.input })),
  });
  registry.group("config", "Локальная конфигурация");
  registry.add("config get", {
    description: "Прочитать конфигурацию выбранного проекта",
    local: true,
    run: (i) => {
      const location = resolveProject(i.options);
      return { data: JSON.parse(readFileSync(location.configPath, "utf8")), meta: { ...location } };
    },
  });
  registry.group("workspace", "Набор независимых локальных проектов");
  registry.group("workspace project", "Регистрации проектов workspace");
  const initialize = {
    description: "Создать пустой локальный workspace",
    local: true,
    run: (i: Invocation) => result(initializeWorkspace(i.options)),
  };
  registry.add("workspace init", initialize);
  registry.add("workspace project init", initialize);
  registry.add("workspace project list", {
    description: "Список зарегистрированных проектов",
    args: pageArgs,
    local: true,
    run: (i) => {
      const projects = listProjects(i.options).sort((a, b) => a.name.localeCompare(b.name));
      return i.page(
        projects,
        {},
        {
          context: JSON.stringify(i.options),
          generation: fingerprint(projects),
        },
      );
    },
  });
  registry.add("workspace project add", {
    description: "Зарегистрировать существующий локальный проект",
    local: true,
    args: {
      name: positional("Имя регистрации"),
      path: positional("Каталог или конфигурация проекта"),
    },
    run: (i) => {
      registerProject(i.options, i.text("name"), i.text("path"));
      return result({ name: i.text("name"), path: i.text("path"), registered: true });
    },
  });
  registry.add("workspace project remove", {
    description: "Удалить регистрацию проекта",
    local: true,
    args: { name: positional("Имя регистрации") },
    run: (i) =>
      result({ name: i.text("name"), removed: unregisterProject(i.options, i.text("name")) }),
  });
}
