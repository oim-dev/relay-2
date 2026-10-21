import type { RuntimeOptions } from "../configuration/runtime-options.types";

/**
 * Параметры создания независимого локального проекта.
 * Проверка имени и slug завершается до создания каталогов и базы.
 * Имя после trim проверяется общим предикатом isProjectName из Contracts.
 * Явный slug не нормализуется и должен соответствовать isEntitySlug из Contracts.
 */
export interface InitializeProjectOptions extends RuntimeOptions {
  /* Отображаемое имя; при отсутствии используется имя cwd либо «Проект» для корня. */
  readonly name?: string;
  /* Явный адрес проекта; при отсутствии выводится из имени либо постоянного ID. */
  readonly slug?: string;
}
