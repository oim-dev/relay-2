/**
 * Диагностики read-only поиска CI и подготовки release assets.
 */
export const releaseMessages = {
  usage:
    "Использование: release.ts find <tag> | select <run-id> | bundle <tag> <downloads-directory> <output-directory>",
  environment: "Требуются GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_TOKEN и GITHUB_OUTPUT",
  response: "GitHub API вернул неподдержанный или повреждённый ответ",
  run: "Release требует успешный ci.yml того же SHA либо текущий run после успешного reusable CI",
  artifacts:
    "В выбранном run нет полного набора бинарных артефактов этого SHA с неистёкшим сроком хранения",
  tag: "Тег должен иметь вид v<semver> и точно совпадать с версиями root и всех приложений",
  output: "Каталог release assets должен быть пустым, чтобы не публиковать файлы прежнего запуска",
  /**
   * Сохраняет HTTP-границу, на которой прервался поиск, без токена.
   */
  api: (status: number, path: string): string => `GitHub API ${path}: HTTP ${status}`,
  /**
   * Указывает manifest с несовпавшей версией выпуска.
   */
  version: (path: string, tag: string): string => `Версия ${path} не соответствует тегу ${tag}`,
  /**
   * Указывает недопустимый бинарник, не пытаясь его запустить или пересобрать.
   */
  binary: (path: string): string => `В release отсутствует обычный исполняемый бинарник: ${path}`,
};
