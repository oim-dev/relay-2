import { serverCommandMessages as messages } from "../locales/commands/server";
import { isObject, renderFullValue } from "./values";

/**
 * Оформляет один результат lifecycle, сохраняя ошибки проектов и различие state/наличия PID.
 */
function instance(value: unknown): string {
  if (!isObject(value)) {
    return renderFullValue(value);
  }
  const states: Readonly<Record<string, string>> = messages.states;
  const scope = isObject(value.scope)
    ? `${value.scope.kind}: ${value.scope.configPath}${value.scope.project ? ` (${value.scope.project})` : ""}`
    : messages.unknown;
  const projects = Array.isArray(value.projects)
    ? value.projects.map((project) => {
        if (!isObject(project)) {
          return renderFullValue(project);
        }
        const error = isObject(project.error)
          ? ` — ${project.error.code}: ${project.error.message}`
          : "";
        return `  ${project.name} (${project.id ?? messages.unknown})${error}`;
      })
    : [];
  const available = Array.isArray(value.projects)
    ? new Set(
        value.projects
          .filter(
            (project) =>
              isObject(project) && project.available === true && typeof project.id === "string",
          )
          .map((project) => project.id),
      ).size
    : 0;
  return [
    `${value.instanceId}: ${states[String(value.state)] ?? value.state}`,
    `  PID: ${value.pid ?? messages.unknown}; URL: ${value.url ?? messages.unknown}`,
    `  ${messages.version}: ${value.version ?? messages.unknown}; ${value.mode ?? messages.unknown}`,
    `  ${messages.scope}: ${scope}`,
    value.state === "ready"
      ? messages.projectCounts(available, projects.length)
      : `${messages.projects}: ${messages.unknown}`,
    ...projects,
    ...(isObject(value.error) ? [`${value.error.code}: ${value.error.message}`] : []),
  ].join("\n");
}

/**
 * Представляет счётчик готовых серверов отдельно от исторических регистраций; JSON не меняется.
 */
export function renderServerStatus(data: unknown): string {
  if (
    isObject(data) &&
    Array.isArray(data.items) &&
    typeof data.running === "number" &&
    typeof data.registered === "number"
  ) {
    return [messages.counts(data.running, data.registered), ...data.items.map(instance)].join(
      "\n\n",
    );
  }
  return instance(data);
}
