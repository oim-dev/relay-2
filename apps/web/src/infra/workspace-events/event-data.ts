import { z } from "zod";
import type { WorkspaceEventName, WorkspaceNotification } from "./events.types";

const eventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.enum(["connected", "changed"]),
    projectId: z.string(),
    generation: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("storage-error"),
    projectId: z.string(),
    generation: z.number().int().nonnegative().nullable(),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);

/**
 * Проверяет SSE envelope до инвалидирования кеша. Событие другого проекта игнорируется;
 * повреждённый JSON/DTO или несовпадение типа отклоняются, а не выглядят как connected.
 */
export function readWorkspaceEvent(
  projectId: string,
  type: WorkspaceEventName,
  data: string,
): WorkspaceNotification | null {
  const event = eventSchema.parse(JSON.parse(data));
  if (event.projectId !== projectId) {
    return null;
  }
  if (event.type !== type) {
    return null;
  }
  return event.type === "storage-error"
    ? { state: "storage-error", message: event.error.message, code: event.error.code }
    : { state: "connected" };
}
