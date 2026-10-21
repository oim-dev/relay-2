import type { Page } from "../pagination/pagination.types";

/**
 * Дополнительные сведения результата; page присутствует только у списочного ответа.
 */
export interface ResultMetadata extends Readonly<Record<string, unknown>> {
  /* Сведения о текущем окне и продолжении из того же снимка, что и data. */
  readonly page?: Page;
}

/**
 * Результат сценария перед представлением CLI; предметная форма data принадлежит Core.
 */
export interface Result {
  /* Полная предметная запись, локальная конфигурация либо состав страницы. */
  readonly data: unknown;
  /* Дополнительные сведения, не подменяющие предметные данные. */
  readonly meta?: ResultMetadata;
}

/**
 * Минимальная структура записи для текстового представления без повторного декодирования Core.
 */
export interface EntityPresentation {
  /* Вид записи; форматирование не проверяет предметный набор видов. */
  readonly kind: unknown;
  /* Читаемый ключ записи, используемый в кратком представлении. */
  readonly key: unknown;
  /* Ревизия содержания, если она присутствует в ответе. */
  readonly revision?: unknown;
  /* Проверенные Core поля, выводимые без дополнительного усечения. */
  readonly data: Readonly<Record<string, unknown>>;
}

/**
 * Объект списочного ответа с дополнительными сведениями владельца состава.
 */
export interface PagePresentation extends Readonly<Record<string, unknown>> {
  /* Записи окна, форматируемые кратко в текстовом режиме. */
  readonly items: readonly unknown[];
}
