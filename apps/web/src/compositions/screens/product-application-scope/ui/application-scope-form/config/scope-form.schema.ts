import { z } from "zod";
import { getContributionTitle, PRODUCT_STATUS_SCHEMA } from "domains/product-demo";

/** Черновик содержит и временно исключённые элементы, чтобы сохранить их тексты. */
export const SCOPE_FORM_SCHEMA = z.object({
  features: z.array(
    z
      .object({
        featureId: z.string(),
        isEnabled: z.boolean(),
        title: z.string().optional(),
        description: z.string(),
        status: PRODUCT_STATUS_SCHEMA.default("none"),
        scenarios: z.array(
          z
            .object({
              scenarioId: z.string(),
              isEnabled: z.boolean(),
              title: z.string().optional(),
              description: z.string(),
              status: PRODUCT_STATUS_SCHEMA.default("none"),
            })
            .transform((entry) => ({
              ...entry,
              title: entry.title ?? getContributionTitle(entry.description),
            })),
        ),
      })
      .transform((entry) => ({
        ...entry,
        title: entry.title ?? getContributionTitle(entry.description),
      })),
  ),
});
/** Версия, относительно которой начато редактирование. */
export const SCOPE_DRAFT_SCHEMA = z.object({
  values: SCOPE_FORM_SCHEMA,
  revision: z.number().int().nonnegative(),
});
