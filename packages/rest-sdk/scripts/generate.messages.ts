/**
 * Диагностика воспроизводимой генерации браузерного SDK.
 */
export const generateMessages = {
  nodeRequired: "Генерация REST SDK требует Node.js 24+; запускайте CLI без --bun",
  invalidArguments: "Допустим только необязательный аргумент --check",
  generationFailed: "Генератор REST SDK завершился с ошибкой",
  current: "REST SDK соответствует apps/server/openapi.json",
  /**
   * Перечисляет отличающиеся файлы для повторной генерации.
   */
  outdated: (files: readonly string[]): string =>
    `REST SDK устарел; выполните bun run --filter @relay/rest-sdk generate:client:\n${files.join("\n")}`,
} as const;
