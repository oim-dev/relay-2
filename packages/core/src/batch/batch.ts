import {
  RelayError,
  validateActor,
  type BatchItemResult,
  type BatchOptions,
  type BatchResult,
} from "@relay/contracts";
import type { ProjectDatabase } from "@relay/storage";
import { EntityReader } from "../projections/entity-reader";
import { batchActions } from "./batch-catalog";
import { BatchStepContext } from "./batch-context";
import { batchFields, batchText, invalidBatch, parseBatch, prepareBatchInput } from "./batch-input";
import { decodeBatchReceipt } from "./batch-receipt";
import { batchMessages } from "./batch.messages";
import { locateBatchError } from "./batch-errors";
import type { BatchExecutionState, BatchStep } from "./batch.types";

/**
 * Служебное исключение только для успешной проверки: результат извлекается после отката SQLite.
 */
class CheckedBatch extends Error {
  /* Подготовленный результат, который не сохранялся и не резервировал ID либо ключи. */
  readonly result: BatchResult;

  /**
   * Передаёт результат за границу rollback, сохраняя идентичность исключения в Storage.
   */
  constructor(result: BatchResult) {
    super();
    this.result = result;
  }
}

/**
 * Выполняет предметные операции одного проекта атомарно через существующие сервисы Core.
 * Журнал и изменения входят в одну внешнюю транзакцию; формат вывода не входит в идентичность.
 */
export class BatchService {
  /* Открытое соединение проекта; временем жизни и закрытием владеет приложение. */
  private readonly db: ProjectDatabase;

  /**
   * Подключает исполнитель к выбранной БД, не открывая дополнительных ресурсов.
   */
  constructor(db: ProjectDatabase) {
    this.db = db;
  }

  /**
   * Нормализует исходный JSON без БД, затем выполняет 1..200 действий v1 в объявленном порядке.
   * Применение требует operationKey. Повтор нормализованного запроса с тем же автором возвращает
   * первоначальную квитанцию до разрешения адресов и CAS; иное содержание даёт CONFLICT.
   * check выполняет тот же сценарий с rollback, без квитанции и расхода ключа.
   */
  execute(input: unknown, options: BatchOptions): BatchResult {
    batchFields(options, ["actor", "operationKey", "check"], "options");
    const actor = validateActor(options.actor);
    if (options.check !== undefined && typeof options.check !== "boolean") {
      invalidBatch(batchMessages.check, "options.check");
    }
    const key =
      options.operationKey === undefined
        ? null
        : batchText(options.operationKey, "options.operationKey");
    if (!options.check && key === null) {
      invalidBatch(batchMessages.operationKey, "options.operationKey");
    }
    const prepared = prepareBatchInput(input, actor);
    const { requestJson } = prepared;
    try {
      return this.db.transaction(() => {
        if (!options.check && key !== null) {
          const previous = this.db.getBatchReceipt(key);
          if (previous !== undefined) {
            if (previous.requestJson !== requestJson) {
              throw new RelayError("CONFLICT", batchMessages.keyConflict, 4, { operationKey: key });
            }
            return decodeBatchReceipt(previous.resultJson, key, this.db.projectId);
          }
        }
        const operations = parseBatch(prepared, batchActions);
        const result = this.runSteps(operations, actor, key, options.check === true);
        if (options.check) {
          throw new CheckedBatch(result);
        }
        if (key !== null) {
          this.db.insertBatchReceipt({
            operationKey: key,
            requestJson,
            resultJson: JSON.stringify(result),
          });
        }
        return result;
      });
    } catch (error) {
      if (error instanceof CheckedBatch) {
        return error.result;
      }
      throw error;
    }
  }

  /**
   * Читает неизменяемую первоначальную квитанцию без текущих адресов/ревизий, в том числе после reopen.
   * Отсутствие ключа даёт NOT_FOUND; повреждение сохранённого результата — CORRUPT_DATA.
   */
  getResult(operationKey: string): BatchResult {
    const key = batchText(operationKey, "operationKey");
    const receipt = this.db.getBatchReceipt(key);
    if (receipt === undefined) {
      throw new RelayError("NOT_FOUND", batchMessages.missingReceipt, 3, { operationKey: key });
    }
    return decodeBatchReceipt(receipt.resultJson, key, this.db.projectId);
  }

  /**
   * Выполняет шаги под внешней транзакцией, затем читает только затронутые записи один раз.
   * Сервисы сами управляют графами своего шага; итоговая проекция разделов общая и уже актуальная.
   */
  private runSteps(
    operations: readonly BatchStep[],
    actor: string,
    operationKey: string | null,
    check: boolean,
  ): BatchResult {
    const state: BatchExecutionState = {
      aliases: new Map(),
      authorizedOwners: new Set(),
      touched: new Set(),
    };
    const items = operations.map((step, index) => this.runStep(step, index, actor, state));
    const reader = new EntityReader(this.db);
    const entities = this.db.getMany([...state.touched]).map((record) => reader.decode(record));
    return {
      operationKey,
      status: check ? "checked" : "committed",
      replayed: false,
      items,
      entities,
    };
  }

  /**
   * Дополняет успешный предметный результат координатами и разрешает его локальное имя для следующих шагов.
   * Любой отказ покидает внешнюю транзакцию с координатами операции и исходной причиной.
   */
  private runStep(
    step: BatchStep,
    index: number,
    actor: string,
    state: BatchExecutionState,
  ): BatchItemResult {
    try {
      const action = batchActions.get(step.op);
      if (action === undefined) {
        invalidBatch(batchMessages.unknownOperation, `operations[${index}].op`);
      }
      const context = new BatchStepContext(this.db, step, action, index, actor, state);
      const outcome = action.execute(context);
      const item: BatchItemResult = {
        ...outcome.primary,
        index,
        op: step.op,
        as: step.as,
        owner: outcome.owner,
        outputs: outcome.outputs,
      };
      if (step.as !== null) {
        state.aliases.set(step.as, item);
      }
      return item;
    } catch (error) {
      throw locateBatchError(error, index, step.op);
    }
  }
}
