import type { ServerProject } from "@relay/contracts";
import type {
  ProjectSelectionGroup,
  ProjectSelectionOption,
} from "../types/project-selection.types";

/**
 * Кодирует UI-адрес выбора отдельно от постоянного projectId и служебных регистраций.
 */
export function projectSelectionValue(projectId: string): string {
  return JSON.stringify(["project", projectId]);
}

/**
 * Группирует доступные алиасы одного ID без дополнительных API-чтений и изменения входа.
 * Недоступные регистрации остаются отдельными disabled-вариантами. Порядок соответствует
 * первому появлению группы в контексте; стоимость — линейная по числу имён регистраций.
 */
export function projectSelectionOptions(
  projects: readonly ServerProject[],
): ProjectSelectionOption[] {
  const groups = new Map<string, ProjectSelectionGroup>();
  for (const [index, project] of projects.entries()) {
    const available = project.available && project.id !== null;
    const value = available
      ? projectSelectionValue(project.id)
      : JSON.stringify(["registration", index]);
    const group = groups.get(value);
    if (group !== undefined) {
      group.names.push(project.name);
      continue;
    }
    groups.set(value, {
      value,
      names: [project.name],
      projectId: available ? project.id : null,
      disabled: !available,
    });
  }
  return [...groups.values()].map((group) => ({
    ...group,
    names: [...group.names],
    label: group.names.join(" · "),
  }));
}
