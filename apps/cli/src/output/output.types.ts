import type { EntityKind } from "@relay/contracts";
import type { Page } from "../pagination/pagination.types";

/**
 * Явный текстовый макет команды; хранится в регистрации и не входит в JSON-ответ.
 */
export type TextPresentation =
  "configuration" | "task-comments" | "session-tree" | "overview" | "workspace-projects";

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
  /* Постоянный ID, если он присутствует; нужен для связей внутри страницы дерева. */
  readonly id?: unknown;
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
 * Адрес и точность названия в кратком предметном макете; обычные списки сохраняют прежний вид.
 */
export interface EntitySummaryOptions {
  /* Подписанный адрес для смешанной карты; отсутствие использует исходный ключ. */
  readonly key?: string;
  /* Сохраняет пробелы названия в специальных макетах; обычный список сворачивает их. */
  readonly preserveTitleWhitespace?: boolean;
}

/**
 * Объект списочного ответа с дополнительными сведениями владельца состава.
 */
export interface PagePresentation extends Readonly<Record<string, unknown>> {
  /* Записи окна; полноту текстовой карточки определяет макет команды. */
  readonly items: readonly unknown[];
}

/**
 * Минимальная проекция сводки для макета; предметные записи уже проверены Core.
 */
export interface OverviewPresentation extends PagePresentation {
  /* Карточка проекта для краткой шапки вместо полного паспорта. */
  readonly project: EntityPresentation;
  /* Поколение общего снимка сводки и страницы карты. */
  readonly generation: number;
  /* Глобальные счётчики каждого вида, включая нули. */
  readonly counts: Readonly<Record<EntityKind, number>>;
  /* Глобальная сводка задач, не ограниченная страницей карты. */
  readonly tasks: TaskOverviewPresentation;
}

/**
 * Числовые агрегаты задач, необходимые компактной сводке.
 */
export interface TaskOverviewPresentation {
  /* Общее число задач проекта. */
  readonly total: number;
  /* Число задач по колонкам в порядке сводки Core. */
  readonly columns: Readonly<Record<string, number>>;
  /* Число задач с незавершёнными прямыми обязательствами. */
  readonly blocked: number;
}
