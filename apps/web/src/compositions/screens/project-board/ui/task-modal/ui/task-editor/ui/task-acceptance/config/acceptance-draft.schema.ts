import { z } from "zod";

/** Черновик изолирован проектом, задачей и вкладкой; ревизия защищает введённый текст. */
export const ACCEPTANCE_DRAFT_SCHEMA = z.object({
  criterionId: z.string().nullable(),
  revision: z.number(),
  wasCompleted: z.boolean(),
  values: z.object({ title: z.string(), summary: z.string(), description: z.string() }),
  request: z.object({ fingerprint: z.string(), id: z.string() }).optional(),
});
/** Сохранённый ввод формы критерия. */
export type AcceptanceDraft = z.infer<typeof ACCEPTANCE_DRAFT_SCHEMA>;
