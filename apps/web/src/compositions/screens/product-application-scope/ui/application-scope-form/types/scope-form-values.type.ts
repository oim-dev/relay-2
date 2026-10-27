import type { z } from "zod";
import type { SCOPE_FORM_SCHEMA } from "../config/scope-form.schema";

/** Единственный источник значений формы выбора и описания вкладов. */
export type ScopeFormValues = z.infer<typeof SCOPE_FORM_SCHEMA>;
/** Элемент, описание которого сейчас открыто. */
export type ScopeTarget = {
  /** Родительская фича. */
  featureId: string;
  /** Сценарий; отсутствие означает общий вклад в фичу. */
  scenarioId?: string;
};
