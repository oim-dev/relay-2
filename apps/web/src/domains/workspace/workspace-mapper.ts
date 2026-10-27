import type { ServerContext } from "@relay/contracts";
import type { RelayWorkspace, WorkspaceProject } from "./workspace.types";

/**
 * Сохраняет реальные aliases/slug и объединяет имена для отображения одного ID.
 * Недоступные регистрации остаются отдельными пунктами с исходной причиной.
 */
export function mapWorkspace(data: ServerContext): RelayWorkspace {
  const names = new Map<string, string[]>();
  for (const project of data.projects) {
    if (project.id === null) continue;
    const aliases = names.get(project.id) ?? [];
    aliases.push(project.name);
    names.set(project.id, aliases);
  }
  return {
    mode: data.mode === "project" ? "local" : "workspace",
    defaultProject:
      data.mode === "project"
        ? (data.projects.find((project) => project.available)?.id ?? null)
        : null,
    projects: data.projects.map((project, index) => ({
      key: project.name,
      id: project.id ?? `unavailable:${index}`,
      name:
        project.id === null ? project.name : (names.get(project.id) ?? [project.name]).join(" / "),
      ...(project.slug === null ? {} : { slug: project.slug }),
      aliases: [
        ...new Set([
          project.name,
          ...(project.id === null ? [] : (names.get(project.id) ?? [])),
          ...(project.slug === null ? [] : [project.slug]),
        ]),
      ],
      available: project.available,
      ...(project.error === undefined
        ? {}
        : { error: `${project.error.message} (${project.error.code})` }),
    })),
  };
}

/**
 * ID имеет приоритет. Alias/slug принимается только при единственном владельце,
 * а не по порядку регистраций. Неизвестный или неоднозначный адрес не выбирает проект.
 */
export function resolveWorkspaceProject(
  workspace: RelayWorkspace | undefined,
  reference: string | undefined,
): WorkspaceProject | undefined {
  if (workspace === undefined || reference === undefined) return undefined;
  const byId = workspace.projects.find((project) => project.id === reference);
  if (byId !== undefined) return byId;
  const matches = workspace.projects.filter((project) => project.aliases.includes(reference));
  return new Set(matches.map((project) => project.id)).size === 1 ? matches[0] : undefined;
}
