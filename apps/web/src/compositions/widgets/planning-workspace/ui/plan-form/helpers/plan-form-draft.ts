import { z } from "zod";
import { readSessionStored, writeSessionStored, removeSessionStored } from "infra/browser-storage";
import type { PlanFormValues } from "../types/plan-form-props.type";

const MARKDOWN = z.array(z.string()).transform((lines) => lines.join("\n"));
const DRAFT_SCHEMA = z.object({
  revision: z.number().int().nonnegative(),
  title: z.string(),
  summary: z.string(),
  goal: MARKDOWN,
});

/**
 * Восстанавливает ввод текущей вкладки только при известной схеме и исходном режиме создания.
 * Старый browser persistence не читается: после reload нет соответствующего frozen request.
 */
export const readPlanDraft = (
  key: string,
  fallback: PlanFormValues,
): { values: PlanFormValues; error: string | null } => {
  try {
    const content = readSessionStored(key);
    if (content === undefined) {
      return { values: fallback, error: null };
    }
    const parsed = DRAFT_SCHEMA.safeParse(content);
    if (parsed.success && (parsed.data.revision === 0) === (fallback.revision === 0)) {
      return { values: parsed.data, error: null };
    }
    return {
      values: fallback,
      error: "Черновик имеет неизвестный формат. Перед новым сохранением явно сбросьте его.",
    };
  } catch {
    return {
      values: fallback,
      error: "Не удалось прочитать черновик. Ввод в открытой форме остаётся доступным.",
    };
  }
};

/**
 * Сохраняет текстовые поля и исходный CAS в памяти вкладки отдельно от подтверждённого плана.
 */
export const writePlanDraft = (key: string, values: PlanFormValues): string | null => {
  const stored = writeSessionStored(key, { ...values, goal: values.goal.split("\n") });
  return stored
    ? null
    : "Черновик не сохранён в браузере. Не закрывайте форму до сохранения плана.";
};

/**
 * Удаляет только подтверждённый либо явно отклонённый черновик.
 */
export const clearPlanDraft = (key: string): void => {
  removeSessionStored(key);
};
