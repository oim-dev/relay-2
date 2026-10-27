import type { DocumentationScope } from "../types/documentation.type";

/** Отображаемые типы материалов. */
export const DOCUMENTATION_KINDS = {
  specification: "Техническое задание",
  description: "Описание",
  rules: "Правила",
  decision: "Решение",
  proposal: "Проект решения",
  instruction: "Инструкция",
  research: "Исследование",
};
/** Варианты поля вида документа. */
export const DOCUMENTATION_KIND_OPTIONS = Object.entries(DOCUMENTATION_KINDS).map(
  ([value, label]) => ({ value, label }),
);
/** Самостоятельные визуальные примеры всех шести уровней будущих связей. */
export const DOCUMENTATION_SCOPE_MOCKS: DocumentationScope[] = [
  {
    id: "demo-product",
    group: "product",
    kind: "Продукт",
    name: "Напрокат",
    path: "Продукт целиком",
  },
  { id: "demo-catalog", group: "product", kind: "Фича", name: "Каталог вещей", path: "Напрокат" },
  {
    id: "demo-search",
    group: "product",
    kind: "Сценарий",
    name: "Поиск вещей",
    path: "Напрокат / Каталог вещей",
  },
  { id: "demo-booking", group: "product", kind: "Фича", name: "Бронирование", path: "Напрокат" },
  {
    id: "demo-confirm",
    group: "product",
    kind: "Сценарий",
    name: "Подтверждение бронирования",
    path: "Напрокат / Бронирование",
  },
  {
    id: "demo-web",
    group: "application",
    kind: "Приложение",
    name: "Веб",
    path: "Пользовательский интерфейс",
  },
  {
    id: "demo-web-catalog",
    group: "application",
    kind: "Реализация фичи",
    name: "Каталог вещей",
    path: "Веб",
  },
  {
    id: "demo-web-search",
    group: "application",
    kind: "Реализация сценария",
    name: "Поиск вещей",
    path: "Веб / Каталог вещей",
  },
  {
    id: "demo-api",
    group: "application",
    kind: "Приложение",
    name: "API",
    path: "Серверная часть",
  },
  {
    id: "demo-api-booking",
    group: "application",
    kind: "Реализация фичи",
    name: "Бронирование",
    path: "API",
  },
  {
    id: "demo-api-confirm",
    group: "application",
    kind: "Реализация сценария",
    name: "Подтверждение бронирования",
    path: "API / Бронирование",
  },
  {
    id: "demo-admin",
    group: "application",
    kind: "Приложение",
    name: "Админка",
    path: "Рабочее место поддержки",
  },
];
