import type { z } from "zod";
import type { PRODUCT_FORM_SCHEMA } from "../config/form.schema";

/** Значения формы, включая ещё не выбранные связи. */
export type ProductFormValues = z.infer<typeof PRODUCT_FORM_SCHEMA>;
