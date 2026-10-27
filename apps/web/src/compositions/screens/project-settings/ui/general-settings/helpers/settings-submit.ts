import type { ProjectSettings, SaveProjectSettingsInput } from "domains/project";
import type { SettingsFormValues } from "../config/form.schema";

/**
 * Не позволяет обновлённым settings отключить проверку receipt. При pending разрешён
 * только исходный submit, а rebase/reset запрещены до достоверного результата.
 */
export function settingsSavePolicy(
  settings: ProjectSettings,
  values: SettingsFormValues,
  baseRevision: number,
  pending: SaveProjectSettingsInput | undefined,
): {
  /* Текущий ввод отличается от подтверждённых значений сервера. */
  hasChanges: boolean;
  /* Достоверно новая версия требует явного решения; pending ещё не является конфликтом. */
  hasConflict: boolean;
  /* Можно отправить новый ввод либо проверить исходную неопределённую запись. */
  canSave: boolean;
  /* Reset и rebase разрешены только после достоверного исхода предыдущей отправки. */
  canReset: boolean;
} {
  const hasChanges = values.name !== settings.name || values.slug !== settings.slug;
  const hasConflict = pending === undefined && settings.revision > baseRevision;
  return {
    hasChanges,
    hasConflict,
    canSave: pending !== undefined || (hasChanges && !hasConflict),
    canReset: pending === undefined && (hasChanges || hasConflict),
  };
}

/**
 * Возвращает исходный submit при повторе; новые значения и свежий CAS его не заменяют.
 * Первичная отправка получает отдельный объект, не связанный с mutable values формы.
 */
export function settingsSubmitInput(
  values: SettingsFormValues,
  baseRevision: number,
  pending: SaveProjectSettingsInput | undefined,
): SaveProjectSettingsInput {
  return pending ?? { name: values.name.trim(), slug: values.slug, ifRevision: baseRevision };
}
