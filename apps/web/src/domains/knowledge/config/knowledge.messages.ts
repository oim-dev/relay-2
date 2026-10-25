import { APPLICATION_TYPES, IMPLEMENTATION_STATUSES } from "@relay/contracts";

/**
 * Подписи каталогов и реальных сохраняемых состояний Core.
 */
export const knowledgeLabels = {
  product: "Продукт",
  feature: "Фичи",
  scenario: "Сценарии",
  application: "Приложения",
  implementation: "Реализации",
} as const;

const applicationLabels = {
  frontend: "Пользовательский интерфейс",
  backend: "Серверное приложение",
  internal: "Внутренний инструмент",
} as const;
const implementationLabels = {
  none: "Не реализовано",
  partial: "Частично",
  done: "Реализовано",
} as const;

export const applicationOptions = APPLICATION_TYPES.map((value) => ({
  value,
  label: applicationLabels[value],
}));
export const implementationOptions = IMPLEMENTATION_STATUSES.map((value) => ({
  value,
  label: implementationLabels[value],
}));

export const knowledgeMessages = {
  wrongOwner: "Исходная карточка не соответствует владельцу изменения знания",
  unknown: "Не удалось завершить операцию. Черновик сохранён.",
  uncertain:
    "Ответ о записи не получен. Черновик и исходная команда сохранены. Повторная отправка проверит прежнюю операцию; поля остаются заблокированы до установления результата.",
  pickerSearch: "Найти по названию или ключу",
  pickerMore: "Загрузить ещё варианты",
  pickerRetry: "Повторить чтение",
  loading: "Загрузка…",
  unavailable: "Запись недоступна",
  retry: "Повторить чтение",
  empty: "Нет подходящих записей",
  active: "Активна",
  inactive: "Участие снято",
  required: "Заполните поле",
  operation: "Результат сохранения",
};

/**
 * Возвращает подпись сохранённого состояния реализации.
 */
export function implementationLabel(status: keyof typeof implementationLabels): string {
  return implementationLabels[status];
}

/**
 * Называет сохранённое участие независимо от готовности реализации.
 */
export function implementationActivityLabel(active: boolean): string {
  return active ? knowledgeMessages.active : knowledgeMessages.inactive;
}
