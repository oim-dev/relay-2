import { statusCommandMessages as messages } from "../locales/commands/status";
import { renderServerStatus } from "./server";
import { isObject, renderFullValue } from "./values";

/**
 * Представляет независимую ошибку элемента; никакого повторного I/O или проверки БД в renderer нет.
 */
function failure(value: unknown): string[] {
  return isObject(value) ? [`  ${value.code}: ${value.message}`] : [];
}

/**
 * Показывает все БД home с известными конфигами и отдельной меткой текущего проекта.
 */
function project(value: unknown): string {
  if (!isObject(value)) {
    return renderFullValue(value);
  }
  let synchronization: string = messages.unknown;
  if (value.synchronization === "auto") {
    synchronization = messages.auto;
  } else if (value.synchronization === "manual") {
    synchronization = messages.manual;
  }
  return [
    `${value.current ? "* " : "  "}${value.name ?? messages.unknown} (${value.projectId}) — ${value.available ? messages.available : messages.unavailable}${value.current ? ` [${messages.current}]` : ""}`,
    `  ${messages.database}: ${value.databasePath}`,
    `  ${messages.synchronization}: ${synchronization}`,
    ...(Array.isArray(value.configPaths) ? value.configPaths.map((path) => `  ${path}`) : []),
    ...failure(value.error),
  ].join("\n");
}

/**
 * Показывает конфиги, включая ошибки и workspace-регистрации; неизвестные пути не угадываются.
 */
function configuration(value: unknown): string {
  if (!isObject(value)) {
    return renderFullValue(value);
  }
  return [
    `  ${value.path} (${value.kind ?? messages.unknown})`,
    ...(Array.isArray(value.registrations)
      ? value.registrations.flatMap((entry) =>
          isObject(entry) ? [`    ${entry.name}: ${entry.path}`] : [],
        )
      : []),
    ...failure(value.error),
  ].join("\n");
}

/**
 * Оформляет глобальную сводку готовых данных; серверный статус использует общий renderer CLI.
 */
export function renderRelayStatus(value: unknown): string {
  if (
    !isObject(value) ||
    !isObject(value.cli) ||
    !isObject(value.context) ||
    !isObject(value.environment)
  ) {
    return renderFullValue(value);
  }
  const projects = Array.isArray(value.projects) ? value.projects : [];
  const configs = Array.isArray(value.configurations) ? value.configurations : [];
  return [
    `${messages.cli}: ${value.cli.version}`,
    `${messages.executable}: ${value.cli.executablePath ?? messages.unknown}`,
    `RELAY_HOME: ${value.home}`,
    `${messages.cwd}: ${value.context.cwd}`,
    `${messages.currentConfig}: ${value.context.configPath ?? messages.none}`,
    ...failure(value.context.error),
    "",
    `${messages.projects} (${projects.length}): ${value.projectsPath}`,
    ...(projects.length ? projects.map(project) : [`  ${messages.none}`]),
    "",
    `${messages.servers}: ${value.serversPath}`,
    renderServerStatus(value.servers),
    "",
    `${messages.configurations}:`,
    ...(configs.length ? configs.map(configuration) : [`  ${messages.none}`]),
    "",
    `${messages.environment}:`,
    ...Object.entries(value.environment).map(
      ([name, content]) => `  ${name}=${content ?? messages.none}`,
    ),
  ].join("\n");
}
