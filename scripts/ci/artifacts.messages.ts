/**
 * Диагностики передачи результатов сборки между CI jobs.
 */
export const artifactMessages = {
  usage:
    "Использование: artifacts.ts pack <component> <target> <directory> | restore <component> <task> <target> <downloads-directory>",
  sha: "Требуется полный GITHUB_SHA: 40 строчных шестнадцатеричных символов",
  toolchain: "Bun и Node.js должны совпадать с закреплёнными версиями checkout",
  windowsTar: "Для передачи CI на Windows требуется SystemRoot со встроенным System32/tar.exe",
  unsafeArchive: "Архив должен содержать только обычные файлы и каталоги разрешённого output",
  output: "CI должен передать GITHUB_OUTPUT для публикации результата упаковки",
  rollback:
    "Не удалось полностью откатить публикацию; staging и резервные output сохранены в .artifacts",
  /**
   * Указывает неизвестного производителя или target.
   */
  input: (value: string): string => `Неизвестный или несовместимый компонент/target: ${value}`,
  /**
   * Объясняет невозможность использования бинарника другой платформы.
   */
  host: (target: string): string => `Нативный артефакт ${target} не соответствует текущему хосту`,
  /**
   * Указывает отсутствующий либо недопустимый файл передачи.
   */
  missing: (path: string): string => `Отсутствует обычный файл или каталог артефакта: ${path}`,
  /**
   * Показывает bundle с несовместимой metadata без попытки его пересобрать.
   */
  metadata: (name: string): string =>
    `Metadata артефакта ${name} не соответствует checkout и каталогу`,
  /**
   * Показывает архив с повреждёнными байтами.
   */
  hash: (name: string): string => `SHA-256 архива ${name} не совпадает с manifest.json`,
  /**
   * Сохраняет диагностику системной команды упаковки/распаковки.
   */
  command: (command: string, stderr: string): string => `Не выполнена ${command}: ${stderr}`,
  /**
   * Запрещает выход временных материалов за разрешённую область.
   */
  workspace: (path: string): string =>
    `Каталог CI должен находиться в .artifacts/YYYY-MM-DD/: ${path}`,
  /**
   * Объясняет отказ следовать ссылке в пути output.
   */
  destination: (path: string): string =>
    `Путь output должен состоять из обычных каталогов: ${path}`,
};
