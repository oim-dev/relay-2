import { z } from "zod";

const RETURN_SCHEMA = z.object({
  returnTo: z.string().optional(),
  editorReturnTo: z.string().optional(),
});

/**
 * Восстанавливает адрес возврата только внутри указанной области текущего проекта.
 */
export const getProductReturn = (
  state: unknown,
  fallback: string,
  basePath: string,
  field: "returnTo" | "editorReturnTo" = "returnTo",
): string => {
  const parsed = RETURN_SCHEMA.safeParse(state);
  if (!parsed.success) return fallback;
  const returnTo = parsed.data[field];
  if (returnTo === undefined) return fallback;
  return returnTo === basePath || returnTo.startsWith(`${basePath}/`) ? returnTo : fallback;
};
