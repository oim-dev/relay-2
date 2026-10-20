import type { I18nPluginOptions } from "@gunshi/plugin-i18n";

export const russianResources = {
  COMMAND: "КОМАНДА",
  COMMANDS: "КОМАНДЫ",
  SUBCOMMAND: "ПОДКОМАНДА",
  USAGE: "ИСПОЛЬЗОВАНИЕ",
  ARGUMENTS: "АРГУМЕНТЫ",
  OPTIONS: "ПАРАМЕТРЫ",
  EXAMPLES: "ПРИМЕРЫ",
  FORMORE: "Подробнее о команде — с параметром --help",
  NEGATABLE: "Отключить",
  DEFAULT: "по умолчанию",
  CHOICES: "допустимые значения",
  help: "Показать справку",
  version: "Показать версию",
  "err:arg:required-option": "Не указан обязательный параметр {$displayName}",
  "err:arg:required-positional": "Не указан обязательный аргумент {$displayName}",
  "err:arg:invalid-type": "Недопустимое значение {$displayName}: ожидается {$expected}",
  "err:arg:invalid-choice": "Недопустимое значение {$displayName}: выберите из {$choices}",
  "err:arg:custom-parse": "Недопустимое значение {$displayName}: {$reason}",
  "err:arg:unknown-option": "Неизвестный параметр: {$rawName}",
  "err:arg:unexpected-value": "Параметр {$displayName} не принимает значение",
  "err:arg:missing-value": "Не указано значение параметра {$displayName}",
  "err:arg:missing-value:hint": "(для передачи «{$next}» используйте «{$suggestion}»)",
  "err:arg:conflict": "Параметры {$displayName} и {$conflictDisplayName} несовместимы",
  "err:arg:invalid-default":
    "Значение по умолчанию {$displayName}: {$actual} не входит в {$choices}",
  "err:cmd:not-found": "Неизвестная команда: «{$commandName}»",
  "err:cmd:ambiguous":
    "Неоднозначная команда. Укажите параметры после имени команды: {$candidatePaths}",
  "err:cmd:inconsistent-options": "Не удалось выбрать команду. Укажите параметры после её имени.",
  "err:cmd:lazy-schema-mismatch":
    "Описание параметров команды {$commandPath} не соответствует её обработчику.",
  "err:suggestion:did-you-mean": "Возможно, вы имели в виду {$name}?",
} satisfies NonNullable<I18nPluginOptions["builtinResources"]>[string];
