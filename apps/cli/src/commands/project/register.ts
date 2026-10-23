import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  initializeProject,
  initializeWorkspace,
  listProjects,
  registerProject,
  resolveProject,
  unregisterProject,
  type RuntimeOptions,
} from "@relay/project-runtime";
import { pageArgs, positional, string, textArgs } from "../../input/arguments";
import { projectCommandMessages as messages } from "../../locales/commands/project";
import { result } from "../../output/output";
import type { Result } from "../../output/output.types";
import { fingerprint } from "../../pagination/pagination";
import type { CommandRegistry } from "../../execution/registry";
import type { Invocation } from "../../execution/invocation";

/**
 * Сериализует проверенный Runtime контекст списка с абсолютными cwd и явным config.
 * Config разрешается от cwd так же, как при чтении и построении nextCommand;
 * его отсутствие сохраняет неявный поиск workspace и привязку курсора к текущему каталогу.
 */
function workspacePageContext(options: RuntimeOptions): string {
  const cwd = resolve(options.cwd);
  return JSON.stringify({
    ...options,
    cwd,
    ...(options.config === undefined ? {} : { config: resolve(cwd, options.config) }),
  });
}

/**
 * Добавляет в реестр локальные команды создания проекта, конфигурации и workspace.
 * Регистрация не читает файлы; операции Runtime выполняются при вызове команды.
 */
export function registerProjectCommands(registry: CommandRegistry): void {
  registry.add("init", {
    ...messages.init,
    local: true,
    fields: { ...textArgs({ name: messages.projectName }), slug: string(messages.projectSlug) },
    /**
     * Создаёт файлы проекта через Runtime и возвращает его локальное расположение.
     */
    run: (i): Result => result(initializeProject({ ...i.options, ...i.input })),
  });
  registry.group("config", messages.config);
  registry.add("config get", {
    ...messages.configGet,
    local: true,
    presentation: "configuration",
    /**
     * Возвращает JSON выбранной конфигурации с метаданными расположения проекта.
     * Ошибки выбора проекта, чтения файла и разбора JSON передаются границе CLI.
     */
    run: (i): Result => {
      const location = resolveProject(i.options);
      return { data: JSON.parse(readFileSync(location.configPath, "utf8")), meta: { ...location } };
    },
  });
  registry.group("workspace", messages.workspace);
  registry.group("workspace project", messages.workspaceProject);
  const initialize = {
    ...messages.workspaceInit,
    local: true,
    /**
     * Создаёт конфигурацию workspace через Runtime и возвращает её расположение.
     */
    run: (i: Invocation): Result => result(initializeWorkspace(i.options)),
  };
  registry.add("workspace init", initialize);
  registry.add("workspace project init", initialize);
  registry.add("workspace project list", {
    ...messages.projectList,
    args: pageArgs,
    local: true,
    presentation: "workspace-projects",
    /**
     * Возвращает страницу регистраций, упорядоченных по имени.
     * Полный реестр читается до пагинации; отпечаток связывает курсор с его содержимым.
     */
    run: (i): Result => {
      const options = i.options;
      const projects = listProjects(options).sort((a, b) => a.name.localeCompare(b.name));
      return i.page(
        projects,
        {},
        {
          context: workspacePageContext(options),
          generation: fingerprint(projects),
        },
      );
    },
  });
  registry.add("workspace project add", {
    ...messages.projectAdd,
    local: true,
    args: {
      name: positional(messages.registrationName),
      path: positional(messages.registrationPath),
    },
    /**
     * Добавляет регистрацию через Runtime и возвращает переданные имя и путь.
     */
    run: (i): Result => {
      registerProject(i.options, i.text("name"), i.text("path"));
      return result({ name: i.text("name"), path: i.text("path"), registered: true });
    },
  });
  registry.add("workspace project remove", {
    ...messages.projectRemove,
    local: true,
    args: { name: positional(messages.registrationName) },
    /**
     * Удаляет регистрацию и возвращает признак удаления; отсутствие записи даёт false.
     */
    run: (i): Result =>
      result({ name: i.text("name"), removed: unregisterProject(i.options, i.text("name")) }),
  });
}
