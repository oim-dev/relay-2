import { z } from "zod";
import { readSessionStored, writeSessionStored, removeSessionStored } from "infra/browser-storage";
import type { ReleaseFormValues } from "../types/release-form-props.type";

const MARKDOWN = z.array(z.string()).transform((lines) => lines.join("\n"));
const DRAFT_SCHEMA = z.object({
  revision: z.number().int().nonnegative(),
  title: z.string(),
  version: z.string(),
  summary: z.string(),
  description: MARKDOWN,
  plannedFor: z.string(),
  status: z.enum(["planned", "released", "cancelled"]),
  planIds: z.array(z.string()),
});

/**
 * Результат восстановления черновика текущей вкладки.
 */
type DraftResult = {
  /* Восстановленный ввод. */
  values: ReleaseFormValues;
  /* Причина отказа. */
  error: string | null;
};

/**
 * Восстанавливает draft памяти вкладки с исходной ревизией; старый persistence не читается.
 * После reload не возрождает создание с утраченным operationKey.
 */
export const readReleaseDraft = (key: string, fallback: ReleaseFormValues): DraftResult => {
  try {
    const content = readSessionStored(key);
    if (content !== undefined) {
      const parsed = DRAFT_SCHEMA.safeParse(content);
      if (parsed.success && (parsed.data.revision === 0) === (fallback.revision === 0)) {
        return { values: parsed.data, error: null };
      }
      return {
        values: fallback,
        error: "Черновик релиза имеет неизвестный формат. Сбросьте его явно, чтобы продолжить.",
      };
    }
    return { values: { ...fallback, planIds: [...fallback.planIds] }, error: null };
  } catch {
    return {
      values: fallback,
      error: "Не удалось восстановить черновик релиза. Исходные данные сохранены.",
    };
  }
};

/**
 * Записывает ввод и CAS в память вкладки отдельно от подтверждённого релиза.
 */
export const writeReleaseDraft = (key: string, values: ReleaseFormValues): string | null => {
  const stored = writeSessionStored(key, {
    ...values,
    description: values.description.split("\n"),
  });
  return stored
    ? null
    : "Черновик не сохранился в браузере. Не закрывайте форму до сохранения релиза.";
};

/**
 * Очищает подтверждённый либо явно отброшенный черновик этого редактора.
 */
export const clearReleaseDraft = (key: string): void => {
  removeSessionStored(key);
};
