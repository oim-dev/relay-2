import { RelayError, type TaskRecord } from "@relay/contracts";
import type { CommandContext } from "../commands/command-context";
import { decodeKnowledge } from "../knowledge/knowledge-data";
import { taskRecord } from "./task-data";
import type { TaskTarget } from "./task-data.types";
import type {
  TaskCreatePreparation,
  TaskLinkContext,
  TaskMoveContext,
  TaskParentContext,
  TaskTargetContext,
} from "./task-command.types";
import type {
  CreateTaskInput,
  MoveTaskInput,
  TaskLinkChange,
  UpdateTaskInput,
} from "./task-input.types";
import { taskMessages } from "./task-messages";

/**
 * Загружает только переданные цели и декодирует их у владельца знаний.
 * Принадлежность доске, активность и дубли проверяет чистый calculator.
 */
async function loadTaskTargets(
  commands: CommandContext,
  refs: readonly string[],
): Promise<TaskTarget[]> {
  const targets: TaskTarget[] = [];
  for (const ref of refs) {
    const record = await commands.get(ref);
    switch (record.kind) {
      case "feature":
      case "scenario":
      case "implementation":
        targets.push(decodeKnowledge(record, record.kind));
        break;
      default:
        throw new RelayError("INVALID_ARGUMENT", taskMessages.targetKind, 2);
    }
  }
  return targets;
}

/**
 * Загружает только явно переданные задачи; дубли сохраняет для проверки после разрешения алиасов.
 */
async function loadTaskReferences(
  commands: CommandContext,
  refs: readonly string[],
): Promise<TaskRecord[]> {
  const records: TaskRecord[] = [];
  for (const ref of refs) {
    records.push(taskRecord(await commands.get(ref, "task")));
  }
  return records;
}

/**
 * Получает конечный контекст создания и выделяет ID/ключ до чистого расчёта.
 * Граф читается узкой проекцией, полные карточки загружаются лишь для явных ссылок.
 */
export async function loadTaskCreate(
  commands: CommandContext,
  input: CreateTaskInput,
): Promise<TaskCreatePreparation> {
  const board = decodeKnowledge(await commands.get(input.board, "board"), "board");
  const parent =
    input.parent === null ? null : taskRecord(await commands.get(input.parent, "task"));
  const dependencies = await loadTaskReferences(commands, input.dependencies);
  const related = await loadTaskReferences(commands, input.related);
  const targets = await loadTaskTargets(commands, input.targets);
  const graphRecords = await commands.graphRecords();
  const id = commands.allocateId();
  if ((await commands.identity(id)) !== null) {
    throw new RelayError("CONFLICT", taskMessages.allocatedIdConflict, 4, { id });
  }
  return {
    context: { board, parent, dependencies, related, targets, graphRecords },
    allocation: {
      id,
      actor: commands.actor,
      timestamp: commands.timestamp,
      key: await commands.key("task", board.data.prefix),
      criterionIds: input.acceptanceCriteria.map(() => commands.allocateId()),
    },
  };
}

/**
 * Загружает доску и выбранные цели только при их явной замене; обычный текст не читает граф.
 */
export async function loadTaskUpdate(
  commands: CommandContext,
  current: TaskRecord,
  input: UpdateTaskInput,
): Promise<TaskTargetContext | undefined> {
  if (input.targets === undefined) {
    return undefined;
  }
  return {
    board: decodeKnowledge(await commands.get(current.data.boardId, "board"), "board"),
    targets: await loadTaskTargets(commands, input.targets),
  };
}

/**
 * Получает новую доску, прежние назначения и узкий граф; ключ выделяет лишь при смене доски.
 */
export async function loadTaskMove(
  commands: CommandContext,
  current: TaskRecord,
  input: MoveTaskInput,
): Promise<TaskMoveContext> {
  const board = decodeKnowledge(
    await commands.get(input.board ?? current.data.boardId, "board"),
    "board",
  );
  return {
    board,
    targets: await loadTaskTargets(commands, current.data.targets),
    graphRecords: await commands.graphRecords(),
    key:
      board.id === current.data.boardId
        ? current.key
        : await commands.key("task", board.data.prefix),
  };
}

/**
 * Получает выбранного родителя и граф без записи и без предметного пересчёта.
 */
export async function loadTaskParent(
  commands: CommandContext,
  parent: string | null,
): Promise<TaskParentContext> {
  return {
    parent: parent === null ? null : taskRecord(await commands.get(parent, "task")),
    graphRecords: await commands.graphRecords(),
  };
}

/**
 * Получает цель связи и граф для единственного чистого перехода.
 */
export async function loadTaskLink(
  commands: CommandContext,
  change: TaskLinkChange,
): Promise<TaskLinkContext> {
  return {
    target: taskRecord(await commands.get(change.target, "task")),
    graphRecords: await commands.graphRecords(),
  };
}
