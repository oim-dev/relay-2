import type {
  CommandExecutionContext,
  CommandWriteOptions,
  HistoryCheckpoint,
  HistoryCheckpointAction,
  HistoryContext,
  HistorySession,
} from "@relay/contracts";
import type { ProjectStore } from "@relay/storage";
import { executeEntityCommand } from "../commands/command-facade";
import { decodeHistoryCheckpoint, decodeHistorySession } from "./history-data";
import {
  historyCheckpointInput,
  historyStartInput,
  historyTransitionInput,
  historyWriteOptions,
} from "./history-input";
import { HistoryReader } from "./history-reader";

export type {
  HistorySessionStatus,
  HistoryCheckpointKind,
  HistoryOperator,
  HistoryRun,
  HistorySessionData,
  HistoryReference,
  HistoryCheckpointData,
  HistorySession,
  HistoryCheckpoint,
} from "@relay/contracts";

/**
 * Публичный async фасад единственного command executor; согласованные чтения остаются синхронными.
 * Владение соединением и его закрытие остаются вызывающему приложению.
 */
export class HistoryService {
  /* Открытый проект для command port и оптимизированных чтений. */
  private readonly db: ProjectStore;
  /* Ожидаемые привязки адресов и переносимый token владельца по умолчанию. */
  private readonly execution: CommandExecutionContext;
  /* Читатель без межоперационного кеша. */
  private readonly reader: HistoryReader;

  /**
   * Подключает сервис к открытому проекту без I/O.
   */
  constructor(db: ProjectStore, execution: CommandExecutionContext = {}) {
    this.db = db;
    this.execution = execution;
    this.reader = new HistoryReader(db);
  }

  /**
   * Возвращает проверенную сессию по ID, ключу или типизированной ссылке.
   */
  get(ref: string): HistorySession {
    return this.reader.session(ref);
  }

  /**
   * Возвращает неизменяемый материал; повреждённое хранение отклоняется.
   */
  getCheckpoint(ref: string): HistoryCheckpoint {
    return this.reader.checkpoint(ref);
  }

  /**
   * Декодирует полный набор сессий до фильтрации в одном снимке; новые возвращаются первыми.
   */
  list(filters: unknown = {}): HistorySession[] {
    return this.reader.list(filters);
  }

  /**
   * Создаёт корневую сессию и первое участие одним guarded commit; повтор создаёт новую сессию.
   */
  async start(input: unknown, actor: string): Promise<HistorySession> {
    historyStartInput(input);
    // Предметный parser выше проверил объект и каждое поле, исходное отсутствие/null сохраняется.
    const commandInput = input as Readonly<Record<string, unknown>>;
    return decodeHistorySession(
      await executeEntityCommand(
        this.db,
        { op: "session.start", input: commandInput },
        actor,
        this.execution,
      ),
    );
  }

  /**
   * Выполняет переход с исходным CAS/token сессии; для fork владельцем является родитель intent.
   * Явный token метода заменяет default конструктора; переданный numeric CAS проверяется вместе с ним.
   * Владелец run и автор проверяются чистыми правилами. Конфликт не переисполняет команду.
   */
  async transition(
    ref: string,
    action: string,
    input: unknown,
    options: Readonly<CommandWriteOptions>,
  ): Promise<HistorySession> {
    const write = historyWriteOptions(options, this.execution.expectedVersion);
    historyTransitionInput(action, input);
    // Проверенный предметным parser объект передаётся без нормализации отсутствующих полей.
    const commandInput = input as Readonly<Record<string, unknown>>;
    return decodeHistorySession(
      await executeEntityCommand(
        this.db,
        {
          op: `session.${action}`,
          ref,
          input: commandInput,
          ...(write.ifRevision === undefined ? {} : { ifRevision: write.ifRevision }),
          ...(write.expectedVersion === undefined
            ? {}
            : { expectedVersion: write.expectedVersion }),
        },
        write.actor,
        this.execution,
      ),
    );
  }

  /**
   * Добавляет материал и повышает ревизию сессии атомарно. open адресует сессию, остальные — intent.
   * Числовой CAS либо переносимый token относится к сессии; явно переданный token имеет приоритет.
   * Снимки references и sessionRevision фиксируются в момент шага; одинаковый save не является no-op.
   */
  async checkpoint(
    ref: string,
    action: HistoryCheckpointAction,
    input: unknown,
    options: Readonly<CommandWriteOptions>,
  ): Promise<HistoryCheckpoint> {
    const write = historyWriteOptions(options, this.execution.expectedVersion);
    historyCheckpointInput(action, input);
    // Parser проверил форму исходного объекта; ID, адреса и отсутствие полей передаются дословно.
    const commandInput = input as Readonly<Record<string, unknown>>;
    return decodeHistoryCheckpoint(
      await executeEntityCommand(
        this.db,
        {
          op: `checkpoint.${action}`,
          ref,
          input: commandInput,
          ...(write.ifRevision === undefined ? {} : { ifRevision: write.ifRevision }),
          ...(write.expectedVersion === undefined
            ? {}
            : { expectedVersion: write.expectedVersion }),
        },
        write.actor,
        this.execution,
      ),
    );
  }

  /**
   * Возвращает хронологический журнал сессии либо проекта из полного согласованного набора материалов.
   */
  history(ref?: string): HistoryCheckpoint[] {
    return this.reader.history(ref);
  }

  /**
   * Возвращает дерево в ширину, читая полный набор сессий в одном снимке.
   */
  tree(ref: string): HistorySession[] {
    return this.reader.tree(ref);
  }

  /**
   * Выбирает открытые намерения сессии либо дерева; полный журнал читается до фильтрации.
   */
  intents(ref: string, includeChildren = false): HistoryCheckpoint[] {
    return this.reader.intents(ref, { includeChildren });
  }

  /**
   * Собирает карточку, материалы, намерения и прямых детей из одного снимка полных наборов.
   */
  context(ref: string): HistoryContext {
    return this.reader.context(ref);
  }
}
