/**
 * Диагностики полного check, каталога компонентов и сверки конфигурации.
 */
export const verificationMessages = {
  concurrency: "check принимает только --concurrency=1..32; все штатные проверки обязательны",
  gitRequired: "Для полного набора проверок требуется Git в PATH",
  uniqueComponents: "Имена каталогов компонентов CI должны быть уникальны",
  missingTurboTasks: "turbo.json не содержит tasks",
  mandatoryExecution:
    "Workflow должен сохранять обязательные leaf-команды и их ненулевой код выхода",
  missingPortableRunner: "Не задан runner переносимых проверок",
  ciDrift:
    "CI не соответствует package scripts и модели проверок. Выполните bun run ci:generate и проверьте diff.",
  aligned: "План check и CI согласован: наборы, leaf-команды и build-зависимости.",

  /**
   * Указывает несовпадение запущенного Bun с закреплённой конфигурацией.
   */
  bunRequired: (expected: string, actual: string): string =>
    `Требуется согласованный Bun ${expected}; запущен ${actual}`,

  /**
   * Указывает закреплённую версию Node.js для Vite и генерации.
   */
  nodeRequired: (version: string): string => `Требуется Node.js ${version} из .node-version`,

  /**
   * Показывает проверенные версии инструментов без записи отчёта.
   */
  environment: (bun: string, node: string, git: string): string =>
    `Bun ${bun}; Node.js ${node}; ${git}`,

  /**
   * Указывает manifest без обязательного имени workspace.
   */
  missingWorkspaceName: (path: string): string => `У workspace отсутствует имя: ${path}`,

  /**
   * Указывает manifest с неверной формой scripts.
   */
  invalidScripts: (path: string): string => `Некорректные scripts: ${path}`,

  /**
   * Указывает команду, которую нельзя передать исполнителю как строку.
   */
  invalidCommand: (component: string, command: string): string =>
    `Некорректная команда ${component}/${command}`,

  /**
   * Указывает неизвестный ID результата сборки.
   */
  unknownArtifact: (id: string): string => `Неизвестный артефакт: ${id}`,

  /**
   * Объясняет отказ использовать имя каталога в GitHub job ID.
   */
  invalidComponent: (id: string): string => `Некорректное имя компонента CI: ${id}`,

  /**
   * Требует включить новый штатный набор в общий план.
   */
  unplannedSuite: (component: string, task: string): string =>
    `Новый набор ${component}/${task} нужно включить в общий план check и CI`,

  /**
   * Показывает отсутствующую обязательную часть Quality job.
   */
  missingLint: (component: string): string => `Компонент ${component} не объявляет lint`,

  /**
   * Указывает единственную самостоятельную команду lint для всего компонента.
   */
  lintCommand: (component: string): string =>
    `${component}/lint: leaf-команда должна быть bun --bun oxlint --deny-warnings .`,

  /**
   * Разрешает проверку нескольких профилей без компиляции или запуска соседних задач.
   */
  typecheckCommand: (component: string): string =>
    `${component}/typecheck: leaf-команда допускает только tsc --noEmit или bun --bun tsc --noEmit; дополнительные профили задаются через -p <tsconfig.json> и &&`,

  /**
   * Не позволяет потерять существующие тесты или создать зелёный пустой job.
   */
  suiteScriptMismatch: (component: string, kind: string): string =>
    `${component}/test:${kind}: набор и package script должны существовать вместе`,

  /**
   * Показывает канонический вход собственного набора без вложенных проверок и сборок.
   */
  suiteCommand: (component: string, kind: string, command: string): string =>
    `${component}/test:${kind}: leaf-команда должна запускать весь собственный набор: ${command}`,

  /**
   * Объясняет запрет рекурсивного исполнителя внутри leaf-команды.
   */
  nonLeafCommand: (component: string, task: string): string =>
    `${component}/${task}: leaf-команда не должна запускать другой набор или скрывать его отсутствие`,

  /**
   * Требует зарегистрировать результат добавленной сборки для CI-потребителей.
   */
  missingBuildArtifact: (component: string): string =>
    `Для build компонента ${component} не объявлен единственный артефакт`,

  /**
   * Показывает отсутствующую задачу локального DAG.
   */
  missingTurboTask: (task: string): string => `В Turbo не объявлена задача ${task}`,

  /**
   * Показывает неверную форму списка prerequisites.
   */
  invalidDependencies: (task: string): string => `Некорректные зависимости ${task}`,

  /**
   * Указывает результат, у которого нет workspace-производителя.
   */
  missingProducer: (id: string): string => `Нет производителя ${id}`,

  /**
   * Сравнивает ожидаемые и объявленные build-зависимости одной команды.
   */
  dependencyDrift: (task: string, expected: readonly string[], actual: readonly string[]): string =>
    `Turbo и CI расходятся для ${task}: ожидаются ${expected.join(", ")}, заданы ${actual.join(", ")}`,

  /**
   * Требует единственную исполняющую декларацию обязательного шага.
   */
  ambiguousStep: (name: string): string =>
    `Workflow должен однозначно связывать leaf-команды шага ${name}`,

  /**
   * Показывает подменённый параметр вызова общего dispatcher.
   */
  changedBinding: (name: string, key: string): string =>
    `Workflow подменяет leaf-команды: ${name}/${key}`,

  /**
   * Требует один job, чтобы reusable workflow не размножал штатные проверки.
   */
  singleJob: (name: string): string => `${name} должен содержать один job общих leaf-команд`,

  /**
   * Запрещает скрытую матрицу или отключение job внутри reusable workflow.
   */
  workflowMultiplicity: (name: string): string =>
    `${name} не должен размножать или скрывать leaf-команды`,

  /**
   * Объясняет отличие shell-пути workflow от общей leaf-команды.
   */
  workflowCommands: (name: string): string =>
    `${name} должен исполнять только общие leaf-команды check/CI`,
} as const;
