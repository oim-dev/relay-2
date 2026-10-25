import {
  BATCH_LIMITS,
  HTTP_COMMAND_EXAMPLES,
  HTTP_COMMAND_INPUT_SCHEMAS,
  type BatchOperationDescription,
  type CommandJsonSchema,
} from "@relay/contracts";
import { openapiMessages } from "./openapi/generation.messages";

const address: CommandJsonSchema = { type: "string", minLength: 1 };
const localReference: CommandJsonSchema = {
  type: "object",
  properties: { $ref: address },
  required: ["$ref"],
  additionalProperties: false,
  description:
    "Основной ID предыдущего шага с указанным as. Ссылки вперёд и неподходящие виды отклоняет Core.",
};
const localRevision: CommandJsonSchema = {
  type: "object",
  properties: { $revision: address },
  required: ["$revision"],
  additionalProperties: false,
  description:
    "Ревизия владельца предыдущего результата. Владелец должен совпадать и быть создан либо уже авторизован исходным guard в этом batch.",
};
const revision: CommandJsonSchema = {
  type: "integer",
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
};
const writeProperties: Readonly<Record<string, CommandJsonSchema>> = {
  actor: { ...address, description: "Явный автор, сохраняемый дословно." },
  operationKey: {
    ...address,
    description:
      "Ключ доставки первоначального запроса; повтор с тем же ключом и другим запросом отклоняется.",
  },
  expectedAddresses: {
    type: "array",
    items: {
      type: "object",
      properties: { ref: address, expectedId: address },
      required: ["ref", "expectedId"],
      additionalProperties: false,
    },
    description: "Исходные привязки адресов из чтения. Сервер не подставляет актуальные ID.",
  },
};

/**
 * Добавляет $ref только в путь, опубликованный текущим Core. Ветки structured target
 * и nullable сохраняются; отсутствие пути возвращает undefined для отказа вызывающего генератора.
 */
function addLocalReference(
  schema: CommandJsonSchema,
  segments: readonly string[],
): CommandJsonSchema | undefined {
  if (segments.length === 0) {
    return { oneOf: [schema, localReference] };
  }
  const [first, ...rest] = segments;
  if (schema.oneOf !== undefined) {
    let found = false;
    const branches = schema.oneOf.map((branch) => {
      const changed = addLocalReference(branch, segments);
      if (changed !== undefined) {
        found = true;
        return changed;
      }
      return branch;
    });
    if (found) {
      return { ...schema, oneOf: branches };
    }
  }
  if (first === "*" && schema.items !== undefined) {
    const items = addLocalReference(schema.items, rest);
    return items === undefined ? undefined : { ...schema, items };
  }
  const property = first === undefined ? undefined : schema.properties?.[first];
  if (first !== undefined && property !== undefined) {
    const changed = addLocalReference(property, rest);
    return changed === undefined
      ? undefined
      : { ...schema, properties: { ...schema.properties, [first]: changed } };
  }
  return undefined;
}

/**
 * Сверяет две независимые декларации: ни новая операция Core, ни новое поле input
 * не могут незаметно остаться свободным JSON в публикуемом внешнем контракте.
 */
export function assertCommandSchemaCoverage(catalog: readonly BatchOperationDescription[]): void {
  const published = catalog.map((operation) => operation.op).sort();
  const described = Object.keys(HTTP_COMMAND_INPUT_SCHEMAS).sort();
  if (JSON.stringify(published) !== JSON.stringify(described)) {
    throw new Error(openapiMessages.commandCatalog(published, described));
  }
  for (const operation of catalog) {
    const fields = Object.keys(HTTP_COMMAND_INPUT_SCHEMAS[operation.op]?.properties ?? {}).sort();
    if (JSON.stringify(fields) !== JSON.stringify([...operation.inputFields].sort())) {
      throw new Error(openapiMessages.commandFields(operation.op));
    }
  }
}

/**
 * Описывает адресуемую сущность отдельно от владельца CAS вложенного действия истории.
 */
function commandReferenceKind(operation: string): string {
  if (
    operation === "session.fork" ||
    (operation.startsWith("checkpoint.") && operation !== "checkpoint.open")
  ) {
    return "work-checkpoint";
  }
  if (operation.startsWith("session.") || operation === "checkpoint.open") {
    return "work-session";
  }
  const family = operation.split(".")[0] ?? operation;
  return family === "plan" ? "work-plan" : family;
}

/**
 * Собирает закрытую оболочку одного действия. HTTP использует строгий batch-путь Core,
 * поэтому conditional-create точечных внутренних фасадов здесь не применяется.
 */
function operationSchema(operation: BatchOperationDescription, batch: boolean): CommandJsonSchema {
  let input = HTTP_COMMAND_INPUT_SCHEMAS[operation.op];
  if (input === undefined) {
    throw new Error(openapiMessages.commandInput(operation.op));
  }
  if (batch) {
    for (const path of operation.referenceFields) {
      const expanded = addLocalReference(input, path.split("."));
      if (expanded === undefined) {
        throw new Error(openapiMessages.commandReference(operation.op, path));
      }
      input = expanded;
    }
    if (operation.op === "plan.stage.task.transfer") {
      input = {
        ...input,
        properties: {
          ...input.properties,
          targetRevision: {
            oneOf: [revision, localRevision],
            description:
              "Исходная CAS целевого плана либо ревизия его предыдущего результата; при targetVersion необязательна. Оба переданных guards проверяются независимо.",
          },
        },
      };
    }
  }
  const properties: Record<string, CommandJsonSchema> = {
    op: { type: "string", const: operation.op, enum: [operation.op] },
    as: { ...address, description: "Уникальное в пределах пакета имя основного результата." },
    input,
    ...(batch ? {} : writeProperties),
  };
  const required = batch ? ["op"] : ["op", "actor", "operationKey"];
  if (
    (input.required?.length ?? 0) > 0 ||
    (input.minProperties ?? 0) > 0 ||
    input.anyOf !== undefined ||
    input.oneOf !== undefined
  ) {
    required.push("input");
  }
  if (operation.ref === "required") {
    properties.ref = {
      ...(batch ? { oneOf: [address, localReference] } : address),
      description: `Постоянный ID, ключ или алиас ${commandReferenceKind(operation.op)}. Принадлежность вложенного объекта и исходную привязку адреса проверяет Core.`,
    };
    required.push("ref");
  }
  if (operation.revisionOwner !== null) {
    properties.ifRevision = {
      ...(batch ? { oneOf: [revision, localRevision] } : revision),
      description: `Исходная локальная CAS владельца ${operation.revisionOwner}; если задан expectedVersion, число необязательно. При двух guards проверяются оба.`,
    };
    properties.expectedVersion = {
      ...address,
      description: `Исходная aggregateVersion владельца ${operation.revisionOwner} из versioned read; не версия вложенного объекта.`,
    };
  }
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
    description:
      operation.op === "plan.stage.task.transfer"
        ? "Перенос задачи: верхние ifRevision/expectedVersion защищают исходный план; input.targetRevision/targetVersion независимо защищают целевой план."
        : operation.description,
    "x-relay-revision-owner": operation.revisionOwner,
    "x-relay-reference-fields": operation.referenceFields,
    ...(operation.revisionOwner === null
      ? {}
      : { anyOf: [{ required: ["ifRevision"] }, { required: ["expectedVersion"] }] }),
  };
}

/**
 * Чисто строит discriminated oneOf для HTTP-команд и batch. Каталог передаётся извне;
 * здесь нет БД, Runtime, CLI или нового пути runtime-валидации HTTP.
 */
export function createCommandSchemas(
  catalog: readonly BatchOperationDescription[],
): Readonly<Record<string, CommandJsonSchema>> {
  assertCommandSchemaCoverage(catalog);
  const definitions: Record<string, CommandJsonSchema> = {};
  const batchVariants: CommandJsonSchema[] = [];
  const singleVariants: CommandJsonSchema[] = [];
  for (const operation of catalog) {
    const suffix = operation.op
      .split(".")
      .map((part) => part[0]?.toUpperCase() + part.slice(1))
      .join("");
    const batchName = `HttpBatch${suffix}`;
    const singleName = `HttpCommand${suffix}`;
    definitions[batchName] = operationSchema(operation, true);
    definitions[singleName] = operationSchema(operation, false);
    batchVariants.push({ $ref: `#/definitions/${batchName}` });
    singleVariants.push({ $ref: `#/definitions/${singleName}` });
  }
  definitions.HttpBatchCommand = { oneOf: batchVariants, discriminator: { propertyName: "op" } };
  definitions.NamedCommand = { $ref: "#/definitions/HttpBatchCommand" };
  definitions.HttpCommandRequest = {
    oneOf: singleVariants,
    discriminator: { propertyName: "op" },
    examples: [{ op: "task.create", actor: "Разработчик", operationKey: "example-single" }],
  };
  definitions.HttpBatchRequest = {
    type: "object",
    properties: {
      ...writeProperties,
      commands: {
        type: "array",
        items: { $ref: "#/definitions/HttpBatchCommand" },
        minItems: 1,
        maxItems: BATCH_LIMITS.operations,
      },
      check: {
        type: "boolean",
        description: "Тот же Core commit-путь с откатом, без сохранения данных и квитанции.",
      },
    },
    required: ["actor", "operationKey", "commands"],
    additionalProperties: false,
    examples: Object.values(HTTP_COMMAND_EXAMPLES),
  };
  return definitions;
}
