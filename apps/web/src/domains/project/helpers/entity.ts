import type { ProjectEntity } from "@relay/contracts";

/**
 * Название карточки определяется её публичной дискриминированной схемой.
 */
export function entityName(entity: ProjectEntity): string {
  switch (entity.kind) {
    case "task":
    case "implementation":
    case "work-plan":
    case "release":
      return entity.data.title;
    case "work-session":
      return entity.data.title;
    case "work-checkpoint":
      return entity.data.title;
    default:
      return entity.data.name ?? entity.key;
  }
}

/**
 * Постоянный ID в ссылке переживает перенумерацию читаемого ключа.
 */
export function entityHref(projectId: string, id: string): string {
  return `/projects/${encodeURIComponent(projectId)}/entities/${encodeURIComponent(id)}`;
}
