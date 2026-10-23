import { BATCH_OPERATIONS } from "@relay/core";
import { batchContractMessages as messages } from "../../locales/commands/batch-contract";
import { knowledgeHelpContractFactories } from "./help-contract-knowledge";
import { taskHelpContractFactories } from "./help-contract-tasks";
import { planningHelpContractFactories } from "./help-contract-planning";
import { historyHelpContractFactories } from "./help-contract-history";
import type {
  BatchFieldContract,
  BatchHelpContractDefinition,
  BatchHelpContractFactory,
  BatchOperationContract,
} from "./help-contract.types";

const factories: ReadonlyMap<string, BatchHelpContractFactory> = new Map([
  ...knowledgeHelpContractFactories(),
  ...taskHelpContractFactories(),
  ...planningHelpContractFactories(),
  ...historyHelpContractFactories(),
]);
const operations = new Map(BATCH_OPERATIONS.map((operation) => [operation.op, operation]));
// Кеш заполняется только для запрошенных операций. Данные статичны для версии кода,
// не зависят от БД, env или runtime-контекста и рекурсивно замораживаются перед публикацией.
const contracts = new Map<string, BatchHelpContractDefinition>();

/**
 * Рекурсивно замораживает только что созданное дерево метаданных выбранного листа.
 * Дерево принадлежит справке и не содержит циклов; исходные предметные данные сюда не поступают.
 */
function freezeContractValue<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) {
      freezeContractValue(child);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Создаёт и кеширует только запрошенный контракт без подготовки соседних листов.
 * Не открывает проект и не выполняет предметный валидатор; кеш валиден для версии кода.
 * Неизвестное имя операции считается ошибкой метаданных, а не универсальным fallback.
 */
function operationContract(op: string): BatchHelpContractDefinition {
  const contract = contracts.get(op);
  if (contract) {
    return contract;
  }
  const create = factories.get(op);
  if (!create) {
    throw new Error(messages.unknownOperation(op));
  }
  const created = freezeContractValue(create());
  contracts.set(op, created);
  return created;
}

/**
 * Возвращает обязательность, смысл пропуска и null реального JSON-поля выбранной операции.
 * Политика берётся из предметных деклараций, а не required/default схемы CLI-флагов.
 * Неизвестное поле или неполная декларация приводят к явной ошибке метаданных с путём input.
 */
export function getBatchFieldContract(op: string, field: string): BatchFieldContract {
  if (!factories.has(op)) {
    throw new Error(messages.unknownOperation(op));
  }
  if (!operations.get(op)?.inputFields.includes(field)) {
    throw new Error(messages.unknownField(op, field));
  }
  const definition = operationContract(op);
  if (!Object.hasOwn(definition.fields, field)) {
    throw new Error(messages.unknownField(op, field));
  }
  const contract = definition.fields[field];
  if (!contract) {
    throw new Error(messages.unknownField(op, field));
  }
  return contract;
}

/**
 * Возвращает предметные предусловия и автономный пример листа справки.
 * Метаданные readonly; вызывающий renderer не должен менять их. Никакие записи не читаются.
 */
export function getBatchOperationContract(op: string): BatchOperationContract {
  const { rules, example } = operationContract(op);
  return { rules, example };
}
