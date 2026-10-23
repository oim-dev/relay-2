import {
  DOCUMENT_RELATION_TYPES,
  DOCUMENT_TARGET_KINDS,
  PLAN_SCOPE_KINDS,
  historyOperatorSources,
  type BatchOperationDescription,
} from "@relay/contracts";
import type { ArgSchema } from "gunshi";
import type { RegistryCommand } from "../../execution/registry.types";
import type { CommandHelp } from "../../output/help.types";
import { argumentMessages } from "../../locales/arguments";
import { batchCommandMessages as messages } from "../../locales/commands/batch";
import type { BatchFieldHelp, BatchOperationHelp, BatchStageDirection } from "./help.types";
import { getBatchFieldContract, getBatchOperationContract } from "./help-contract";

const argumentNames: Readonly<Record<string, string>> = {
  featureId: "feature",
  applicationId: "application",
  planIds: "plans",
  version: "release-version",
  runId: "run",
  acceptedSessionIds: "accept",
  stageId: "stage",
  targetStage: "stage",
  criterionId: "criterion",
};
const jsonFields = new Set([
  "document.create.relations",
  "document.update.relations",
  "task.create.acceptanceCriteria",
]);
const stageDirections = { up: true, down: true } satisfies Record<BatchStageDirection, true>;
const referenceFormat = 'string | {"$ref":string}';

/**
 * Находит уже зарегистрированную предметную команду, не вызывая обработчик или parser.
 */
export function findBatchSubjectCommand(
  commands: ReadonlyMap<string, RegistryCommand>,
  op: string,
): RegistryCommand {
  let current: RegistryCommand | undefined;
  for (const part of op.split(".")) {
    current = commands.get(part);
    if (!current) {
      throw new Error(messages.helpMissingCommand(op));
    }
    commands = current.subCommands;
  }
  if (!current) {
    throw new Error(messages.helpMissingCommand(op));
  }
  return current;
}

/**
 * Сопоставляет canonical имя batch с CLI-аргументом; не меняет предметный ввод.
 */
function argumentName(op: string, field: string): string {
  if (op.startsWith("task.criterion.") && field === "id") {
    return "criterion";
  }
  if ((op === "document.link" || op === "document.unlink") && field === "type") {
    return "relation";
  }
  return argumentNames[field] ?? field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/**
 * Сохраняет описание владельца, убирая только известные декорации CLI-транспорта.
 * Обязательность и default схемы не становятся обещаниями предметного JSON-ввода.
 */
function argumentDescription(schema: ArgSchema, path: string): string {
  if (typeof schema.description !== "string" || !schema.description.trim()) {
    throw new Error(messages.helpMissingDescription(path));
  }
  let description = schema.description;
  for (const suffix of [argumentMessages.repeated(""), argumentMessages.required("")]) {
    if (description.endsWith(suffix)) {
      description = description.slice(0, -suffix.length);
    }
  }
  if (!description.trim()) {
    throw new Error(messages.helpMissingDescription(path));
  }
  return description;
}

/**
 * Описывает только поля с отличающейся от CLI формой либо отсутствующим CLI-флагом.
 */
function batchSpecificField(
  op: string,
  name: string,
): Omit<BatchFieldHelp, "contract"> | undefined {
  if ((op === "plan.create" || op === "plan.update") && name === "scope") {
    return {
      name,
      format: messages.fieldFormats.scope,
      description: messages.fieldDescriptions.scope(PLAN_SCOPE_KINDS),
    };
  }
  if (op.startsWith("session.") && name === "operator") {
    return {
      name,
      format: messages.fieldFormats.operator,
      description: messages.fieldDescriptions.operator(historyOperatorSources),
    };
  }
  if (op === "plan.stage.move" && name === "direction") {
    return {
      name,
      format: messages.enumFormat(Object.keys(stageDirections)),
      description: messages.fieldDescriptions.stageDirection,
    };
  }
  if (op === "plan.stage.move" && name === "before") {
    return {
      name,
      format: referenceFormat,
      description: messages.fieldDescriptions.stageBefore,
    };
  }
  return undefined;
}

/**
 * Получает JSON-тип из схемы либо из явного исключения; неизвестный custom не объявляет JSON.
 * Значения enum берутся из живой схемы, а поддержка $ref — из каталога Core.
 */
function fieldFormat(
  operation: BatchOperationDescription,
  name: string,
  schema: ArgSchema,
): string {
  if (operation.op === "plan.stage.task.transfer" && name === "targetRevision") {
    return 'number | {"$revision":string}';
  }
  if (operation.referenceFields.includes(name)) {
    return referenceFormat;
  }
  if (operation.referenceFields.includes(`${name}.*`)) {
    return `(${referenceFormat})[]`;
  }
  let format: string;
  switch (schema.type) {
    case "string":
    case "positional":
      format = "string";
      break;
    case "boolean":
      format = "boolean";
      break;
    case "number":
      format = "number";
      break;
    case "enum":
      if (!schema.choices?.length) {
        throw new Error(messages.helpMissingChoices(`${operation.op}.input.${name}`));
      }
      format = messages.enumFormat(schema.choices);
      break;
    case "custom":
      if (!jsonFields.has(`${operation.op}.${name}`)) {
        throw new Error(messages.helpUnknownFormat(`${operation.op}.input.${name}`));
      }
      format = "JSON";
      break;
    default:
      throw new Error(messages.helpUnknownFormat(`${operation.op}.input.${name}`));
  }
  return schema.multiple ? `${format}[]` : format;
}

/**
 * Дополняет описание только теми особенностями batch, которых нет в схеме отдельной команды.
 */
function describeFieldFormat(
  operation: BatchOperationDescription,
  name: string,
  command: RegistryCommand,
): Omit<BatchFieldHelp, "contract"> {
  const specific = batchSpecificField(operation.op, name);
  if (specific) {
    return specific;
  }
  const schema = command.args?.[argumentName(operation.op, name)];
  const path = `${operation.op}.input.${name}`;
  if (!schema) {
    throw new Error(messages.helpMissingArgument(path));
  }
  let description =
    operation.op.startsWith("checkpoint.") && name === "acceptedSessionIds"
      ? messages.fieldDescriptions.acceptedSessionIds
      : argumentDescription(schema, path);
  const format = fieldFormat(operation, name, schema);
  if (operation.referenceFields.includes(name)) {
    description = messages.fieldReference(description);
  } else if (operation.referenceFields.includes(`${name}.*`)) {
    description = messages.fieldReferenceList(description);
  }
  if (operation.op === "plan.stage.task.transfer" && name === "targetRevision") {
    description = messages.fieldDescriptions.targetRevision(description);
  }
  if (name === "featureId" || name === "applicationId" || name === "criterionId") {
    const alias = name === "criterionId" ? "id" : argumentName(operation.op, name);
    description = messages.fieldAlias(description, alias);
  }
  if (operation.op.startsWith("document.") && name === "relations") {
    description = messages.fieldDescriptions.relations(
      description,
      DOCUMENT_TARGET_KINDS,
      DOCUMENT_RELATION_TYPES,
    );
  }
  return { name, format, description };
}

/**
 * Связывает одно поле с единственным policy присутствия, пропуска и null.
 * Формат nullable не выводится из схемы отдельной команды или из текста описания.
 */
function describeField(
  operation: BatchOperationDescription,
  name: string,
  command: RegistryCommand,
): BatchFieldHelp {
  const field = describeFieldFormat(operation, name, command);
  const contract = getBatchFieldContract(operation.op, name);
  if (contract.nullable && !contract.nullMeaning?.trim()) {
    throw new Error(messages.helpMissingNullMeaning(`${operation.op}.input.${name}`));
  }
  return {
    ...field,
    format: contract.nullable ? `${field.format} | null` : field.format,
    contract,
  };
}

/**
 * Связывает поля только выбранной операции с её командой и предметным policy справки.
 * Не читает проект, stdin и файлы, не запускает парсеры или обработчики.
 * Неполные метаданные дают явную ошибку с путём поля вместо неподтверждённого формата.
 */
export function describeBatchOperation(
  operation: BatchOperationDescription,
  commands: ReadonlyMap<string, RegistryCommand>,
): BatchOperationHelp {
  const command = findBatchSubjectCommand(commands, operation.op);
  const ref = command.args?.ref;
  if (operation.ref === "required" && !ref) {
    throw new Error(messages.helpMissingArgument(`${operation.op}.ref`));
  }
  if (!command.description?.trim()) {
    throw new Error(messages.helpMissingDescription(operation.op));
  }
  return {
    operation,
    title: command.description,
    fields: operation.inputFields.map((name) => describeField(operation, name, command)),
    referenceDescription:
      operation.ref === "required" && ref ? argumentDescription(ref, `${operation.op}.ref`) : null,
  };
}

/**
 * Форматирует поле и его policy без самостоятельных предположений о пропуске либо null.
 */
function renderField(field: BatchFieldHelp): string {
  return [
    messages.field(field.name, field.format, field.description),
    messages.fieldPresence(field.contract.presence),
    messages.fieldOmission(field.contract.omission),
    ...(field.contract.nullable && field.contract.nullMeaning
      ? [messages.fieldNull(field.contract.nullMeaning)]
      : []),
  ].join("\n");
}

/**
 * Представляет контракт одной операции без переноса синтаксиса флагов в canonical input.
 */
function renderOperation({ operation, fields, referenceDescription }: BatchOperationHelp): string {
  return [
    messages.operationCode(operation.op),
    messages.reference(referenceDescription),
    messages.revision(operation.revisionOwner),
    ...(fields.length
      ? [messages.inputHeading, ...fields.map(renderField)]
      : [messages.emptyInput]),
    ...(operation.referenceFields.length
      ? [messages.referenceFields(operation.referenceFields)]
      : []),
  ].join("\n");
}

/**
 * Формирует подробности и готовый JSON-пример только выбранной операции по ленивому запросу.
 * Пример использует --check; ID и ревизии в нём заменяются данными выбранного проекта.
 */
export function createBatchOperationHelp(
  operation: BatchOperationDescription,
  commands: ReadonlyMap<string, RegistryCommand>,
): CommandHelp {
  const help = describeBatchOperation(operation, commands);
  const contract = getBatchOperationContract(operation.op);
  const input = JSON.stringify({ version: 1, operations: [contract.example] }, null, 2);
  const shellInput = `'${input.replaceAll("'", "'\\''")}'`;
  const parent = operation.op.split(".").slice(0, -1).join(" ");
  return {
    description: help.title,
    details: [renderOperation(help), ...contract.rules, messages.operationNavigation(parent)].join(
      "\n\n",
    ),
    examples: [
      {
        description: messages.operationExample,
        command: `relay batch --actor agent --check --input ${shellInput}`,
      },
    ],
  };
}
