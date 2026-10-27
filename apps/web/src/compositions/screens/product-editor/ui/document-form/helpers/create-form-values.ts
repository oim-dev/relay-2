import type { ProductDocumentInput } from "domains/product-demo";
import type { ProductFormValues } from "../types/product-form-values.type";

/**
 * Готовит ввод общих сведений документа.
 */
export const createFormValues = (input: ProductDocumentInput): ProductFormValues => ({
  name: input.name,
  summary: input.summary,
  description: input.description,
  status: input.status,
  type: input.type,
  slug: input.slug,
  prefix: input.prefix,
});
