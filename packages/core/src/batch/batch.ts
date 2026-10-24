import {
  RelayError,
  type BatchItemResult,
  type BatchResult,
  type CommandOptions,
  type CommandStore,
  type CommandReceipt,
  type NamedCommand,
  type EntityKind,
  type VersionedCommandEntity,
} from "@relay/contracts";
import type { ProjectStore } from "@relay/storage";
import { CommandContext } from "../commands/command-context";
import { commandMessages } from "../commands/command.messages";
import { finalizeCommandResult } from "../commands/command-result";
import { readVersionedEntity } from "../commands/command-versioned-read";
import type { CommandResultMaterial } from "../commands/command-result.types";
import type { CommandExecutorCompatibility } from "../commands/command-context.types";
import { decodeKnowledge } from "../knowledge/knowledge-data";
import { indexDocumentSections } from "../knowledge/document-sections";
import { batchActions } from "./batch-catalog";
import { BatchStepContext } from "./batch-context";
import { batchText, invalidBatch, parseBatch, prepareBatchInput } from "./batch-input";
import { parseCommandAddresses, prepareCommandOptions } from "./batch-options";
import { decodeBatchReceipt } from "./batch-receipt";
import { batchMessages } from "./batch.messages";
import { locateBatchError } from "./batch-errors";
import type { BatchExecutionState, BatchStep } from "./batch.types";

/**
 * Единственный async исполнитель single/batch: явные загрузки, чистые предметные эффекты,
 * разреженное промежуточное состояние и один guarded commit. Никогда не повторяет мутацию.
 */
export class CommandExecutor {
  /* Асинхронный command port, без доступа предметных calculators к локальной БД. */
  private readonly store: CommandStore;
  /* Только локальное чтение первоначальной квитанции для совместимого getResult. */
  private readonly local: ProjectStore | undefined;
  /* Совместимость старых точечных TypeScript фасадов; NamedCommand по умолчанию следует batch-каталогу. */
  private readonly compatibility: CommandExecutorCompatibility;

  /**
   * Принимает самостоятельный async port либо локальную БД с предоставленным ею портом.
   */
  constructor(
    source: ProjectStore | CommandStore,
    compatibility: CommandExecutorCompatibility = {},
  ) {
    this.compatibility = { legacyFacade: compatibility.legacyFacade === true };
    if ("commands" in source) {
      this.local = source;
      this.store = source.commands;
    } else {
      this.local = undefined;
      this.store = source;
    }
  }

  /**
   * Передаёт одну команду тому же массивному исполнителю без обязательной receipt.
   */
  execute(input: NamedCommand, options: CommandOptions): Promise<BatchResult> {
    return this.executeCommands([input], options);
  }

  /**
   * Выполняет последовательный массив через общий каталог; receipt необязательна для API.
   */
  executeCommands(
    commands: readonly NamedCommand[],
    options: CommandOptions,
  ): Promise<BatchResult> {
    return this.runCommands({ version: 1, operations: commands }, options, false);
  }

  /**
   * Читает сохраняемый агрегат с отдельным переносимым token для expectedVersion того же владельца.
   */
  readVersioned(ref: string, kind?: EntityKind): Promise<VersionedCommandEntity> {
    return readVersionedEntity(this.store, ref, kind);
  }

  /**
   * Читает сохранённый результат раньше адресных/CAS проверок, не актуализируя его из карточек.
   */
  private async receipt(
    operationKey: string,
    requestJson: string,
  ): Promise<BatchResult | undefined> {
    const loaded = await this.store.load({
      anchor: null,
      selectors: [{ kind: "receipt", operationKey }],
    });
    const observation = loaded.observations[0];
    if (observation?.kind !== "receipt") {
      throw new RelayError("CORRUPT_DATA", commandMessages.observation);
    }
    if (observation.receipt === null) {
      return undefined;
    }
    return this.replay(observation.receipt, requestJson);
  }

  /**
   * Проверяет идентичность исходного запроса и восстанавливает неизменяемую квитанцию.
   */
  private replay(receipt: CommandReceipt, requestJson: string): BatchResult {
    if (receipt.requestJson !== requestJson) {
      throw new RelayError("CONFLICT", batchMessages.keyConflict, 4, {
        operationKey: receipt.operationKey,
      });
    }
    return decodeBatchReceipt(receipt.resultJson, receipt.operationKey, this.store.projectId);
  }

  /**
   * Нормализует вход, готовит все шаги вне writer lock и один раз применяет точный план.
   * Проверка использует тот же SQL-путь с rollback; конкурентный отказ не обновляет CAS.
   */
  protected async runCommands(
    input: unknown,
    options: CommandOptions,
    requireKey: boolean,
  ): Promise<BatchResult> {
    const selected = prepareCommandOptions(options, requireKey);
    const { actor, operationKey: key, check } = selected;
    const prepared = prepareBatchInput(input, actor);
    if (!check && key !== null) {
      const previous = await this.receipt(key, prepared.requestJson);
      if (previous !== undefined) {
        return previous;
      }
    }
    const expectedAddresses = parseCommandAddresses(selected.addresses);
    const commands = new CommandContext(
      this.store,
      actor,
      new Date().toISOString(),
      expectedAddresses,
    );
    try {
      for (const expected of expectedAddresses) {
        const identity = await commands.resolve(expected.ref);
        if (identity.id !== expected.expectedId) {
          throw new RelayError("ADDRESS_CHANGED", commandMessages.addressChanged, 4, {
            ref: expected.ref,
            expectedId: expected.expectedId,
            actualId: identity.id,
          });
        }
      }
      const legacyFacade = !requireKey && this.compatibility.legacyFacade === true;
      const operations = parseBatch(prepared, batchActions, legacyFacade);
      const state: BatchExecutionState = {
        aliases: new Map(),
        authorizedOwners: new Set(),
        touched: new Set(),
      };
      const items: BatchItemResult[] = [];
      for (const [index, step] of operations.entries()) {
        items.push(await this.runStep(commands, step, index, actor, state, legacyFacade));
      }
      const contentOwners = new Set<string>();
      const commentOwners = new Set<string>();
      for (const transition of commands.transitions()) {
        for (const effect of transition.effects) {
          state.touched.add(effect.kind === "entity" ? effect.after.id : effect.taskId);
          if (effect.kind === "entity") {
            contentOwners.add(effect.after.id);
          } else {
            commentOwners.add(effect.taskId);
          }
        }
      }
      const freshTaskIds = [...commentOwners].filter((id) => !contentOwners.has(id));
      const records = commands.materialize([...state.touched]);
      const project = records.some((record) => record.kind === "document")
        ? commands.materialize([commands.projectId])[0]
        : undefined;
      const material: CommandResultMaterial = {
        projectId: commands.projectId,
        operationKey: key,
        check,
        items,
        records,
        freshTaskIds,
        sections:
          project === undefined
            ? undefined
            : indexDocumentSections(decodeKnowledge(project, "project")),
      };
      const committed = await this.store.commit({
        projectId: commands.projectId,
        replicaId: commands.replicaId(),
        actor,
        timestamp: commands.timestamp,
        check,
        guards: commands.expected(),
        transitions: commands.transitions(),
        counters: commands.counters(),
        receipt:
          key === null || check ? null : { operationKey: key, requestJson: prepared.requestJson },
        commentTaskIds: records
          .filter((record) => record.kind === "task")
          .map((record) => record.id),
        freshTaskIds,
        finalize: (facts) => finalizeCommandResult(material, facts),
      });
      return committed.kind === "replayed"
        ? this.replay(committed.receipt, prepared.requestJson)
        : committed.result;
    } catch (error) {
      if (
        !check &&
        key !== null &&
        error instanceof RelayError &&
        [
          "COMMAND_CONTEXT_CHANGED",
          "REVISION_CONFLICT",
          "VERSION_CONFLICT",
          "ADDRESS_CHANGED",
          "ADDRESS_GUARD_REQUIRED",
          "NOT_FOUND",
        ].includes(error.code)
      ) {
        const previous = await this.receipt(key, prepared.requestJson);
        if (previous !== undefined) {
          return previous;
        }
      }
      throw error;
    }
  }

  /**
   * Сохраняет компактный результат именно этого шага и авторизует его локальное имя.
   */
  private async runStep(
    commands: CommandContext,
    step: BatchStep,
    index: number,
    actor: string,
    state: BatchExecutionState,
    implicitCreation: boolean,
  ): Promise<BatchItemResult> {
    try {
      const action = batchActions.get(step.op);
      if (action === undefined) {
        invalidBatch(batchMessages.unknownOperation, `operations[${index}].op`);
      }
      commands.beginStep(index, step.op);
      const context = new BatchStepContext(
        commands,
        step,
        action,
        index,
        actor,
        state,
        implicitCreation,
      );
      await context.prepare();
      const outcome = await action.execute(context);
      const item: BatchItemResult = {
        ...outcome.primary,
        index,
        op: step.op,
        as: step.as,
        owner: outcome.owner,
        outputs: outcome.outputs,
      };
      if (step.as !== null) {
        state.aliases.set(step.as, structuredClone(item));
      }
      commands.endStep(outcome);
      return item;
    } catch (error) {
      throw locateBatchError(error, index, step.op);
    }
  }

  /**
   * Читает первоначальную receipt локально и синхронно; общий async read port здесь не обещается.
   */
  getResult(operationKey: string): BatchResult {
    const key = batchText(operationKey, "operationKey");
    if (this.local === undefined) {
      throw new RelayError("INVALID_ARGUMENT", commandMessages.unavailable, 2);
    }
    const receipt = this.local.getBatchReceipt(key);
    if (receipt === undefined) {
      throw new RelayError("NOT_FOUND", batchMessages.missingReceipt, 3, { operationKey: key });
    }
    return decodeBatchReceipt(receipt.resultJson, key, this.store.projectId);
  }
}

/**
 * Совместимая v1 оболочка единого исполнителя; apply требует явный operationKey.
 */
export class BatchService extends CommandExecutor {
  /**
   * Выполняет прежний batch-контракт асинхронно с теми же правилами локальных ссылок и первого CAS.
   */
  override execute(input: unknown, options: CommandOptions): Promise<BatchResult> {
    return this.runCommands(input, options, true);
  }
}

/**
 * Функциональный вход единственного исполнителя для любой реализации async command port.
 */
export function executeCommands(
  store: CommandStore,
  commands: readonly NamedCommand[],
  options: CommandOptions,
): Promise<BatchResult> {
  return new CommandExecutor(store).executeCommands(commands, options);
}
