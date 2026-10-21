import { basename, resolve } from "node:path";
import { isEntitySlug, isProjectName, RelayError } from "@relay/contracts";
import { validText } from "../configuration/config";
import type { InitializeProjectOptions } from "./initialization.types";
import { projectMessages } from "./project.messages";

const PROJECT_ID_SLUG_PREFIX_LENGTH = 8;

/**
 * Выбирает и нормализует отображаемое имя до создания файлов проекта.
 * Пробелы по краям удаляются; пустое, слишком длинное или многострочное имя отклоняется.
 */
export function projectName(options: InitializeProjectOptions): string {
  const rawName = options.name ?? (basename(resolve(options.cwd)) || projectMessages.defaultName);
  if (!validText(rawName)) {
    throw new RelayError("INVALID_ARGUMENT", projectMessages.emptyName, 2);
  }
  const name = rawName.trim();
  if (!isProjectName(name)) {
    throw new RelayError("INVALID_ARGUMENT", projectMessages.invalidName, 2);
  }
  return name;
}

/**
 * Сохраняет валидный явный slug либо выводит адрес из имени и при необходимости из ID.
 * Явный пользовательский ввод не исправляется, в отличие от автоматически полученного адреса.
 */
export function projectSlug(name: string, projectId: string, explicit: string | undefined): string {
  const derivedSlug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const slug =
    explicit ??
    (isEntitySlug(derivedSlug)
      ? derivedSlug
      : `project-${projectId.slice(0, PROJECT_ID_SLUG_PREFIX_LENGTH)}`);
  if (!isEntitySlug(slug)) {
    throw new RelayError("INVALID_ARGUMENT", projectMessages.invalidSlug, 2);
  }
  return slug;
}
