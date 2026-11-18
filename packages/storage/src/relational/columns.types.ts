/**
 * Одна скалярная колонка предметной записи и её поле в совместимом DTO.
 * text использует взаимоисключающие TEXT и JSON-string carrier для точных UTF-16 code units.
 */
export interface ColumnDefinition {
  /* Имя поля DTO; точки обозначают вложенный объект, а не произвольный JSON path. */
  readonly field: string;
  /* Постоянное SQL-имя колонки из закрытой схемы. */
  readonly column: string;
  /* text — пользовательский текст; string — lossless SQL-идентичность либо перечисление. */
  readonly storage: "text" | "string" | "integer" | "boolean";
  /* true разрешает SQL NULL и явный null в DTO. */
  readonly nullable?: true;
  /* true сохраняет отсутствующее поле DTO как SQL NULL, не как явный null. */
  readonly optional?: true;
  /* Закрытый набор строковых значений у предметного перечисления. */
  readonly values?: readonly string[];
}

/**
 * Значение одной SQL-колонки после проверки структуры на границе драйвера.
 */
export type SqlScalar = string | number | null;

/**
 * Проверенная динамическая строка только для общего механизма привязки колонок.
 * Публичные переносимые строки имеют точные типы, выведенные из определений таблиц.
 */
export type SqlRow = Record<string, SqlScalar>;

/**
 * Тип основного SQL-слота; пользовательский text может находиться в соседнем carrier.
 */
type ColumnValue<C extends ColumnDefinition> = C["storage"] extends "text"
  ? string | null
  : C["storage"] extends "boolean"
    ? 0 | 1
    : C["storage"] extends "integer"
      ? number
      : C extends { readonly values: readonly string[] }
        ? C["values"][number]
        : string;

/**
 * Точные SQL-колонки декларативного набора, включая nullable и scalar text carriers.
 * Carrier содержит только JSON-строку одного поля; других полей и raw fallback в нём нет.
 */
export type ColumnsRow<C extends readonly ColumnDefinition[]> = {
  readonly [F in C[number] as F["column"]]:
    | ColumnValue<F>
    | (F extends { readonly nullable: true } | { readonly optional: true } ? null : never);
} & {
  readonly [F in C[number] as F["storage"] extends "text" ? `${F["column"]}_json` : never]:
    string | null;
};
