/**
 * Видимые имена компонентов CI; технические ID остаются в каталоге проверок.
 */
export const ciComponentLabels: Readonly<Record<string, string>> = {
  cli: "CLI",
  server: "Server",
  web: "Web",
  "git-sync": "Git Sync",
  contracts: "Contracts",
  core: "Core",
  storage: "Storage",
  "project-runtime": "Project Runtime",
  "rest-sdk": "REST SDK",
  repository: "Repository",
};

/**
 * Читаемые операции в раскрытой группе GitHub Actions.
 */
const ciTaskLabels: Readonly<Record<string, string>> = {
  quality: "Lint и типы",
  build: "Сборка",
  "test:unit": "Модульные тесты",
  "test:integration": "Интеграционные тесты",
  "test:process": "Процессные тесты",
  "test:e2e": "Сквозные тесты CLI",
  "test:e2e:product": "Сквозные тесты продукта",
  "test:unit:repo": "Тесты инфраструктуры",
  "format:check": "Форматирование",
  "verify:configuration": "Согласованность check и CI",
  "test:native-service": "Нативные службы",
};

/**
 * Платформы в видимых именах jobs; технические target ID остаются в каталоге.
 */
const ciTargetLabels: Readonly<Record<string, string>> = {
  "linux-x64": "Linux x64",
  "windows-x64": "Windows x64",
  "macos-arm64": "macOS ARM64",
};

/**
 * Диагностики leaf dispatcher и представление GitHub jobs/summary.
 */
export const ciMessages = {
  workflowName: "CI",
  commonGroup: "Общие",
  resultJob: "Result",
  resultStep: "Проверить все обязательные результаты",
  resultColumns: ["Job", "Результат"],
  failedJobs: "Не прошли обязательные jobs: {jobs}",
  nativeRuntimeOnly: "Native service принадлежит Runtime",
  taskUsage: "Использование: bun scripts/ci/task.ts <component> <task> <target>",
  taskArguments: "Не заданы component/task/target",
  consumerArguments: "Не заданы параметры потребителя артефактов CI",
  generatedHeader: "# Генерируется bun run ci:generate из scripts/verification/ci-model.ts.\n",

  /**
   * Называет группу ОС в боковой панели; переносимые сборки относятся к общим задачам.
   */
  targetGroup: (target: string): string =>
    target === "portable" ? ciMessages.commonGroup : (ciTargetLabels[target] ?? target),

  /**
   * Называет компонент и этап внутри группы: GitHub отображает имя job из reusable workflow.
   */
  taskName: (component: string, task: string): string =>
    `${ciComponentLabels[component] ?? component} · ${ciTaskLabels[task] ?? task}`,

  /**
   * Объясняет отказ передать незарегистрированную задачу исполнителю.
   */
  unknownTask: (task: string): string => `Неизвестная задача ${task}`,

  /**
   * Указывает отсутствующую package-команду выбранного компонента.
   */
  missingTask: (component: string, task: string): string => `Нет команды ${component}/${task}`,

  /**
   * Объясняет отказ потребителя без попытки скрытой пересборки.
   */
  missingArtifact: (id: string, component: string, task: string): string =>
    `Не получен обязательный артефакт ${id} для ${component}/${task}`,

  /**
   * Объясняет несовпадение фактического хоста с target команды.
   */
  hostMismatch: (target: string, platform: string, arch: string): string =>
    `Target ${target} не соответствует хосту ${platform}/${arch}`,

  /**
   * Обозначает начало фактической команды после получения prerequisites.
   */
  taskStarted: (component: string, task: string, target: string): string =>
    `${component} / ${task} / ${target}`,

  /**
   * Отображает exit code как короткий статус CI, не меняя числовой результат процесса.
   */
  result: (code: number): string => (code === 0 ? "успех" : "отказ"),

  /**
   * Показывает результат команды и длительность самого исполнения, без setup.
   */
  taskFinished: (component: string, task: string, code: number, seconds: string): string =>
    `${component} / ${task}: ${ciMessages.result(code)}, ${seconds} с`,

  /**
   * Формирует GitHub step summary; вызывается только CI dispatcher, не локальным check.
   */
  taskSummary: (
    component: string,
    task: string,
    target: string,
    code: number,
    seconds: string,
  ): string =>
    `| Компонент | Задача | Target | Результат | Выполнение |\n|---|---|---|---|---|\n| ${component} | ${task} | ${target} | ${ciMessages.result(code)} | ${seconds} с |\n\n`,
} as const;
