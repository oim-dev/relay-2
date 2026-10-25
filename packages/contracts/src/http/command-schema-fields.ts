import type { CommandJsonSchema } from "./command-schema.types";

/**
 * Текст сохраняется дословно; предметные ограничения длины проверяет Core.
 */
export const commandText: CommandJsonSchema = { type: "string" };

/**
 * Непустой по смыслу текст без изменения пробелов и переносов.
 */
export const commandNonblank: CommandJsonSchema = { type: "string", pattern: "\\S" };

/**
 * Пользовательский адрес; существование, вид и исходную привязку проверяет Core.
 */
export const commandAddress: CommandJsonSchema = { type: "string", minLength: 1 };

/**
 * Заголовок знаний, задач или планирования без разделителей строк.
 */
export const commandTitle: CommandJsonSchema = {
  ...commandNonblank,
  not: { pattern: "[\\r\\n\\u2028\\u2029]" },
};

/**
 * Закрытый объект формы; непереданные поля не заполняются схемой.
 */
export function commandObject(
  properties: Readonly<Record<string, CommandJsonSchema>>,
  required: readonly string[] = [],
  constraints: CommandJsonSchema = {},
): CommandJsonSchema {
  return { type: "object", properties, additionalProperties: false, required, ...constraints };
}

/**
 * Описывает однородный массив, сохраняя допустимость пустого списка.
 */
export function commandArray(items: CommandJsonSchema): CommandJsonSchema {
  return { type: "array", items };
}

/**
 * Добавляет явный null только к полю, у которого он предусмотрен владельцем.
 */
export function commandNullable(schema: CommandJsonSchema): CommandJsonSchema {
  return { oneOf: [schema, { type: "null" }] };
}

/**
 * Требует ровно одно из альтернативных полей; одновременное присутствие запрещено.
 */
export function commandAlias(first: string, second: string): CommandJsonSchema {
  return { oneOf: [{ required: [first] }, { required: [second] }] };
}

/**
 * Сохраняет общее предметное перечисление в JSON Schema без отдельной копии литералов.
 */
export function commandEnum(values: readonly string[]): CommandJsonSchema {
  return { type: "string", enum: values };
}

/**
 * Документирует начальные значения только операции создания; update не наследует defaults.
 * Схема остаётся декларацией, фактическое заполнение выполняет предметный parser Core.
 */
export function commandDefaults(
  properties: Readonly<Record<string, CommandJsonSchema>>,
  defaults: Readonly<Record<string, unknown>>,
): Readonly<Record<string, CommandJsonSchema>> {
  return Object.fromEntries(
    Object.entries(properties).map(([name, schema]) => [
      name,
      Object.hasOwn(defaults, name) ? { ...schema, default: defaults[name] } : schema,
    ]),
  );
}
