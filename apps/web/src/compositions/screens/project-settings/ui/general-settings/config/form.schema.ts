import { z } from "zod";

/**
 * Исходный submit настроек; его CAS не меняется при получении собственного commit по SSE.
 */
const SETTINGS_SUBMIT_SCHEMA = z.object({
  name: z.string(),
  slug: z.string(),
  ifRevision: z.number().int().nonnegative(),
});

/**
 * Draft памяти вкладки; pending сохраняет исходный submit до достоверного ответа или receipt.
 */
export const SETTINGS_DRAFT_SCHEMA = SETTINGS_SUBMIT_SCHEMA.extend({
  pending: SETTINGS_SUBMIT_SCHEMA.optional(),
});

/** Значения ввода, включая временно пустые или неверные строки. */
export type SettingsFormValues = {
  /** Отображаемое имя. */
  name: string;
  /** Сегмент адреса. */
  slug: string;
};
