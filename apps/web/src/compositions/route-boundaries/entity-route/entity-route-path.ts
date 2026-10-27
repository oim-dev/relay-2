import type { ProjectEntity } from "@relay/contracts";

/**
 * Переводит разрешённый Core адрес в существующий экран по постоянным ID.
 */
export function entityRouteTarget(entity: ProjectEntity): string {
  const id = encodeURIComponent(entity.id);
  switch (entity.kind) {
    case "project":
      return "settings";
    case "product":
      return "product/passport";
    case "feature":
      return `product/features/${id}`;
    case "scenario":
      return `product/features/${encodeURIComponent(entity.data.featureId)}/scenarios/${id}`;
    case "application":
      return `product/applications/${id}`;
    case "implementation":
      return `product/applications/${encodeURIComponent(entity.data.applicationId)}/implementations/${id}`;
    case "document":
      return `documents/${id}`;
    case "board":
      return `boards/${encodeURIComponent(entity.data.slug)}`;
    case "task":
      return `tasks/${id}`;
    case "work-plan":
      return `plans/${id}`;
    case "release":
      return `releases/${id}`;
    case "work-session":
      return `work-history?session=${id}`;
    case "work-checkpoint":
      return `work-history?point=${id}&session=${encodeURIComponent(entity.data.sessionId)}`;
  }
}

/**
 * Сохраняет фильтры и hash совместимого адреса. Явная карточка материала имеет
 * приоритет перед прежним query point/checkpoint; board используется только при выборе доски.
 */
export function entityRouteLocation(
  base: string,
  target: string,
  search: string,
  hash: string,
): string {
  const query = new URLSearchParams(search);
  const [path, additions] = target.split("?");
  if (additions !== undefined) {
    const selected = new URLSearchParams(additions);
    if (selected.has("point")) query.delete("checkpoint");
    for (const [key, value] of selected) query.set(key, value);
  }
  query.delete("board");
  return `${base}/${path}${query.size ? `?${query}` : ""}${hash}`;
}
