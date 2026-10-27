import { z } from "zod";
import { PRODUCT_STATUS_SCHEMA } from "domains/product-demo";

/** Проверяет сохранённый ввод, в том числе незаполненные поля. */
export const PRODUCT_FORM_SCHEMA = z.object({
  name: z.string(),
  summary: z.string(),
  description: z.string(),
  status: PRODUCT_STATUS_SCHEMA,
  type: z.string(),
  slug: z.string(),
  prefix: z.string().default(""),
});
/** Черновик сохраняет исходную версию редактирования. */
export const PRODUCT_DRAFT_SCHEMA = z.object({
  values: PRODUCT_FORM_SCHEMA,
  revision: z.number().int().nonnegative(),
});
