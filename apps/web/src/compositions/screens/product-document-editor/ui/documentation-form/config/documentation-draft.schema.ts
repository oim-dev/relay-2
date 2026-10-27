import { z } from "zod";
import { DOCUMENT_INPUT_SCHEMA } from "domains/documents";

/** Черновик хранит исходную ревизию для явного разрешения конфликта. */
export const DOCUMENTATION_DRAFT_SCHEMA = z.object({
  values: DOCUMENT_INPUT_SCHEMA,
  revision: z.number().int().nonnegative(),
});
