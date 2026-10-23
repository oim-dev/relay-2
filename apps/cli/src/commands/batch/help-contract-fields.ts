import { BATCH_OPERATIONS } from "@relay/core";
import { batchContractMessages as messages } from "../../locales/commands/batch-contract";
import type {
  BatchExampleContext,
  BatchExampleObject,
  BatchExampleValue,
  BatchFieldContract,
  BatchHelpContractDefinition,
} from "./help-contract.types";

const catalog = new Map(BATCH_OPERATIONS.map((operation) => [operation.op, operation]));

/**
 * Создаёт политику обязательного поля без значения по умолчанию и без допустимого null.
 */
export function requiredField(): BatchFieldContract {
  return { presence: messages.required, omission: messages.missingRequired, nullable: false };
}

/**
 * Описывает необязательное поле с документированным начальным JSON-значением.
 */
export function defaultField(value: BatchExampleValue): BatchFieldContract {
  return {
    presence: messages.optional,
    omission: messages.defaultValue(JSON.stringify(value)),
    nullable: false,
  };
}

/**
 * Описывает пропуск поля специальным предметным правилом, не делая null допустимым автоматически.
 */
export function optionalField(omission: string): BatchFieldContract {
  return { presence: messages.optional, omission, nullable: false };
}

/**
 * Описывает частичную правку: отсутствие сохраняет значение, общая операция требует непустой patch.
 */
export function updateField(): BatchFieldContract {
  return { presence: messages.optionalUpdate, omission: messages.keep, nullable: false };
}

/**
 * Явно добавляет смысл null к существующей политике, не изменяя переданный объект.
 */
export function nullableField(policy: BatchFieldContract, meaning: string): BatchFieldContract {
  return { ...policy, nullable: true, nullMeaning: meaning };
}

/**
 * Описывает обязательную пару алиасов: ровно одно из имён должно присутствовать.
 */
export function aliasField(other: string): BatchFieldContract {
  return {
    presence: messages.requiredAlias(other),
    omission: messages.omittedAlias(other),
    nullable: false,
  };
}

/**
 * Связывает декларативные поля и пример с публичным descriptor, не вызывая валидаторы или БД.
 * ref и ifRevision берутся из требований каталога; условное число ревизии не читается из проекта.
 */
export function defineContract(
  op: string,
  fields: Readonly<Record<string, BatchFieldContract>>,
  rules: readonly string[],
  input: BatchExampleObject = {},
  context: BatchExampleContext = {},
): BatchHelpContractDefinition {
  const operation = catalog.get(op);
  if (!operation) {
    throw new Error(messages.unknownOperation(op));
  }
  if ((operation.ref === "required") !== (context.ref !== undefined)) {
    throw new Error(messages.invalidExample(op));
  }
  return {
    fields,
    rules,
    example: {
      op,
      ...(context.ref === undefined ? {} : { ref: context.ref }),
      ...(operation.revisionOwner === null ? {} : { ifRevision: context.revision ?? 1 }),
      ...(Object.keys(input).length === 0 ? {} : { input }),
    },
  };
}
