import type { EntityKind } from "@relay/contracts";
import type { EntityAddressField } from "./entity.types";

/**
 * Диагностики общего механизма адресации и записи сущностей.
 */
export const entityMessages = {
  finiteJsonObject: "Данные должны быть конечным JSON-объектом.",
  jsonValuesOnly: "Данные должны содержать только JSON-значения.",
  expectedDataObject: "Ожидается объект данных.",
  positiveRevision: "Требуется положительная целая ревизия.",
  revisionConflict: "Запись уже изменена; перечитайте её ревизию.",
  missingResolvedRecord: "Разрешённая запись отсутствует в снимке.",
  typedReference: "Ожидается ссылка вида kind:ID или kind:ref.",
  ambiguousAddress: "Адрес принадлежит нескольким записям.",
  recordNotFound: "Запись не найдена.",

  /**
   * Называет адресное поле, не прошедшее проверку формата.
   */
  invalidAddressField: (field: EntityAddressField): string => `Некорректное поле: ${field}.`,

  /**
   * Указывает вид, которому должна соответствовать типизированная ссылка.
   */
  expectedReferenceKind: (kind: EntityKind): string => `Ожидалась ссылка вида ${kind}.`,

  /**
   * Описывает попытку присвоить адрес другой записи того же вида.
   */
  occupiedAddress: (address: string): string => `Адрес ${address} уже занят другой записью.`,
} as const;
