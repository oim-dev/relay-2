import type { BatchResult, NamedCommand } from "@relay/contracts";
import { relayClient, RelayApiError } from "infra/tasks-api";
import { pageGeneration, writeCommand, UncertainWriteError } from "domains/relay-data";
import { taskSnapshot, taskRecord, taskView } from "./task-read";
import type {
  ActivityPage,
  ActivityEvent,
  CommentSaved,
  PublishCommentInput,
} from "../types/activity.type";
import type { CriteriaPage, CriterionView, ChangeCriterionInput } from "../types/acceptance.type";
import type {
  BoardTask,
  TasksPage,
  TaskLinksPage,
  TaskSaved,
  TaskFilters,
  CreateTaskInput,
  EditTaskInput,
  ProductGoalProgress,
  TaskExecutionProgress,
  ApplicationTaskProgress,
  MoveTaskInput,
  LinkTaskInput,
} from "../types/board-tasks.type";

/**
 * Предусмотренный отказ канбана; ввод остаётся в открытой форме.
 */
export class BoardTaskError extends Error {
  /**
   * Сохраняет машинную причину и исходное исключение.
   */
  constructor(
    message: string,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * Сохраняет исходную диагностику SDK и неопределённость записи для формы.
 */
async function request<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof RelayApiError || error instanceof UncertainWriteError)
      throw new BoardTaskError(error.message, error.code, { cause: error });
    throw error;
  }
}

/**
 * Адаптирует первоначальную квитанцию; не перечитывает свежую ревизию вместо результата.
 */
function savedTask(result: BatchResult): TaskSaved {
  const item = result.items.at(-1);
  if (!item) throw new Error("Пустая квитанция изменения задачи");
  const task = result.entities.find(
    (entity) => entity.kind === "task" && entity.id === item.owner.id,
  );
  if (!task || task.kind !== "task") throw new Error("В квитанции нет изменённой задачи");
  return {
    id: task.id,
    key: task.key,
    revision: task.revision,
    boardId: task.data.boardId,
    action: item.op,
    requestId: result.operationKey ?? "",
    ...(item.kind === "task-criterion" ? { criterionId: item.id } : {}),
  };
}

/**
 * Читает журнал целиком по текущему API; UI показывает все записи без фиктивного курсора.
 */
export function getTaskComments(
  project: string,
  reference: string,
  _cursor?: string,
): Promise<ActivityPage> {
  return request(async () => {
    const result = await relayClient.read(project, "taskComments", { ref: reference });
    return {
      items: result.data.items
        .map((item, index) => ({
          id: item.id,
          taskId: reference,
          sequence: index + 1,
          at: item.createdAt,
          actor: item.createdBy,
          title: item.title,
        }))
        .reverse(),
      nextCursor: null,
      snapshot: result.data.items.length,
    };
  });
}

/**
 * Загружает тело неизменяемого комментария по постоянному ID.
 */
export function getTaskComment(
  project: string,
  reference: string,
  entryId: string,
): Promise<ActivityEvent> {
  return request(async () => {
    const { data } = await relayClient.read(project, "taskComment", {
      ref: reference,
      id: entryId,
    });
    return {
      id: data.id,
      taskId: reference,
      at: data.createdAt,
      actor: data.createdBy,
      title: data.title,
      description: data.body,
    };
  });
}

/**
 * Дописывает комментарий независимо от ревизии содержания; автора выбирает Server.
 */
export function publishTaskComment(
  project: string,
  reference: string,
  input: PublishCommentInput,
): Promise<CommentSaved> {
  return request(async () => {
    const result = await writeCommand(
      project,
      {
        op: "task.comment.add",
        ref: reference,
        input: { title: input.title, body: input.description },
      },
      input.requestId,
    );
    const item = result.items[0];
    if (!item) throw new Error("Нет квитанции комментария");
    return {
      id: item.owner.id,
      commentId: item.id,
      action: "comment-publish",
      revision: item.owner.revision,
      requestId: result.operationKey ?? input.requestId,
    };
  });
}

/**
 * Получает критерии и ревизию их задачи одним запросом; ограничение относится к выводу.
 */
export function getTaskCriteria(
  project: string,
  reference: string,
  limit = 20,
): Promise<CriteriaPage> {
  return request(async () => {
    const { data } = await relayClient.read(project, "taskCriteria", { ref: reference });
    return {
      items: data.items.slice(0, limit),
      total: data.items.length,
      nextOffset: data.items.length > limit ? limit : null,
      revision: data.revision,
      version: String(data.revision),
    };
  });
}

/**
 * Читает критерий вместе с исходным CAS задачи, а не отдельным последующим чтением.
 */
export function getTaskCriterion(
  project: string,
  reference: string,
  criterionId: string,
): Promise<CriterionView> {
  return request(async () => {
    const { data } = await relayClient.read(project, "taskCriteria", { ref: reference });
    const criterion = data.items.find((item) => item.id === criterionId);
    if (!criterion) throw new BoardTaskError("Критерий не найден", "NOT_FOUND");
    return { criterion, revision: data.revision };
  });
}

/**
 * Передаёт ровно поля выбранной команды критерия и исходную ревизию задачи.
 */
export function changeTaskCriterion(
  project: string,
  reference: string,
  input: ChangeCriterionInput,
): Promise<TaskSaved> {
  let command: NamedCommand;
  const guard = { ref: reference, ifRevision: input.ifRevision };
  if (input.action === "add" || input.action === "update") {
    command = {
      ...guard,
      op: `task.criterion.${input.action}`,
      input: {
        ...(input.action === "update" ? { id: input.criterionId } : {}),
        title: input.title,
        summary: input.summary,
        description: input.description,
      },
    };
  } else {
    command = {
      ...guard,
      op: `task.criterion.${input.action === "remove" ? "remove" : input.completed ? "complete" : "reopen"}`,
      input: { id: input.criterionId },
    };
  }
  return request(async () => savedTask(await writeCommand(project, command, input.requestId)));
}

/**
 * Читает компактное окно и прогресс одним HTTP-запросом с поколением Core.
 */
export function listBoardTasks(
  project: string,
  filters: TaskFilters,
  offset = 0,
  version?: string,
  limit = 40,
): Promise<TasksPage> {
  return request(async () => {
    const page = (
      await relayClient.read(project, "taskViews", {
        query: {
          ...filters,
          offset,
          limit,
          ...(version === undefined ? {} : { generation: pageGeneration(version) }),
        },
      })
    ).data;
    return {
      items: page.items.map(taskView),
      total: page.total,
      nextOffset: page.nextOffset,
      version: String(page.generation),
    };
  });
}

/**
 * Показывает фактическое выполнение задач выбранной текущим фильтром области.
 * Это не готовность фичи, реализации или продукта; страницы содержат задачи, а не legacy-причины.
 */
export function getProductTaskProgress(
  project: string,
  targetId: string,
  offset = 0,
  version?: string,
): Promise<ProductGoalProgress> {
  return request(async () => {
    const page = (
      await relayClient.read(project, "taskViews", {
        query: {
          productTarget: targetId,
          offset,
          limit: 20,
          ...(version === undefined ? {} : { generation: pageGeneration(version) }),
        },
      })
    ).data;
    return {
      total: page.counts.total,
      completed: page.counts.completed,
      isComplete: page.counts.allCompleted,
      version: String(page.generation),
      nextOffset: page.nextOffset,
      reasonCount: page.total,
      reasons: page.items.map((task) => ({
        message: `${task.key}: ${task.progress.completed ? "выполнена" : "не выполнена"}`,
        path: `/tasks/${encodeURIComponent(task.id)}`,
      })),
    };
  });
}

/**
 * Показывает готовность Core и его ID блокеров; не создаёт собственное правило выполнения.
 */
export function getTaskExecutionProgress(
  project: string,
  reference: string,
  offset = 0,
  version?: string,
): Promise<TaskExecutionProgress> {
  return request(async () => {
    const page = (
      await relayClient.read(project, "taskCandidates", {
        query: {
          ref: reference,
          limit: 1,
          ...(version === undefined ? {} : { generation: pageGeneration(version) }),
        },
      })
    ).data;
    const task = page.items[0];
    if (!task) throw new BoardTaskError("Задача не найдена", "NOT_FOUND");
    const progress = task.progress;
    const reasons = progress.blockers.map((id) => ({
      message: `Незавершённая задача: ${id}`,
      path: `/tasks/${encodeURIComponent(id)}`,
    }));
    return {
      isComplete: progress.completed,
      planning: task.assignment,
      version: String(page.generation),
      reasons: reasons.slice(offset, offset + 20),
      reasonCount: reasons.length,
      nextOffset: offset + 20 < reasons.length ? offset + 20 : null,
    };
  });
}

/**
 * Возвращает счётчики задач доски: все задачи и имеющие явные предметные цели.
 * Наличие цели не означает готовность или обязательность реализации приложения.
 */
export function getApplicationTaskProgress(
  project: string,
  board: string,
): Promise<ApplicationTaskProgress> {
  return request(async () => {
    const { counts } = (
      await relayClient.read(project, "taskViews", { query: { board, limit: 1 } })
    ).data;
    return {
      overall: { total: counts.total, completed: counts.completed },
      business: { total: counts.targetedTotal, completed: counts.targetedCompleted },
    };
  });
}

/**
 * Собирает раскрытый объём только с исходным поколением, без склейки разных страниц.
 */
export async function getBoardTaskSlice(
  project: string,
  filters: TaskFilters,
  count: number,
): Promise<TasksPage> {
  let page = await listBoardTasks(project, filters, 0, undefined, Math.min(count, 100));
  const items = [...page.items];
  while (page.nextOffset !== null && items.length < count) {
    page = await listBoardTasks(
      project,
      filters,
      page.nextOffset,
      page.version,
      Math.min(count - items.length, 100),
    );
    items.push(...page.items);
  }
  return { ...page, items };
}

/**
 * Читает полную задачу и её серверный прогресс, отклоняя смешанный снимок.
 */
export function getBoardTask(project: string, reference: string): Promise<BoardTask> {
  return request(
    async () =>
      (
        await taskSnapshot(project, async () => {
          const record = await taskRecord(project, reference);
          const page = (
            await relayClient.read(project, "taskViews", { query: { ref: record.id, limit: 1 } })
          ).data;
          const summary = page.items[0];
          if (!summary) throw new BoardTaskError("Задача не найдена", "NOT_FOUND");
          return { ...taskView(summary), description: record.data.description };
        })
      ).value,
  );
}

/**
 * Читает только прямые зависимости, необязательные связи и родителя, без глобального обхода.
 * Прямые дети показываются отдельным существующим списком подзадач редактора.
 */
export function getTaskLinks(
  project: string,
  reference: string,
  offset = 0,
  version?: string,
): Promise<TaskLinksPage> {
  return request(async () => {
    const snapshot = await taskSnapshot(
      project,
      async () => {
        const task = await taskRecord(project, reference);
        const links: {
          relation: "depends-on" | "blocks" | "related" | "parent" | "child";
          id: string;
        }[] = [
          ...task.data.dependencies.map((id) => ({ relation: "depends-on" as const, id })),
          ...task.data.related.map((id) => ({ relation: "related" as const, id })),
          ...(task.data.parentId === null
            ? []
            : [{ relation: "parent" as const, id: task.data.parentId }]),
        ];
        const window = links.slice(offset, offset + 40);
        const page =
          window.length === 0
            ? undefined
            : (
                await relayClient.read(project, "taskViews", {
                  query: { refs: window.map((link) => link.id), limit: 40 },
                })
              ).data;
        const summaries = new Map(page?.items.map((item) => [item.id, taskView(item)]));
        const items = window.map((link) => {
          const target = summaries.get(link.id);
          if (!target) throw new BoardTaskError("Связанная задача не найдена", "NOT_FOUND");
          return { relation: link.relation, task: target };
        });
        return {
          items,
          total: links.length,
          nextOffset: offset + 40 < links.length ? offset + 40 : null,
        };
      },
      version,
    );
    return { ...snapshot.value, version: String(snapshot.generation) };
  });
}

/**
 * Создаёт задачу штатной командой. После commit возвращает ID без рискованного дополнительного GET.
 */
export function createBoardTask(project: string, input: CreateTaskInput): Promise<TaskSaved> {
  return request(async () => {
    const result = savedTask(
      await writeCommand(
        project,
        {
          op: "task.create",
          input: {
            board: input.board,
            column: input.column,
            title: input.title,
            description: input.description,
            ...(input.parentId ? { parent: input.parentId } : {}),
          },
        },
        input.requestId,
      ),
    );
    return result;
  });
}

/**
 * Обновляет тексты/цели по исходной ревизии; журнал комментариев не передаётся.
 */
export function updateBoardTask(
  project: string,
  reference: string,
  input: EditTaskInput,
): Promise<TaskSaved> {
  return request(async () =>
    savedTask(
      await writeCommand(
        project,
        {
          op: "task.update",
          ref: reference,
          ifRevision: input.ifRevision,
          input: {
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.description === undefined ? {} : { description: input.description }),
            ...(input.productLinks === undefined
              ? {}
              : { targets: input.productLinks.map((link) => link.id) }),
          },
        },
        input.requestId,
      ),
    ),
  );
}

/**
 * Меняет только доску/колонку. Ранга и перестановки внутри колонки в Core нет.
 */
export function moveBoardTask(
  project: string,
  reference: string,
  input: MoveTaskInput,
): Promise<TaskSaved> {
  return request(async () =>
    savedTask(
      await writeCommand(
        project,
        {
          op: "task.move",
          ref: reference,
          ifRevision: input.ifRevision,
          input: {
            column: input.column,
            ...(input.board === undefined ? {} : { board: input.board }),
          },
        },
        input.requestId,
      ),
    ),
  );
}

/**
 * Переводит вид связи в точное действие Core с исходным guard задачи.
 */
export function linkBoardTask(
  project: string,
  reference: string,
  input: LinkTaskInput,
): Promise<TaskSaved> {
  const op =
    input.relation === "parent"
      ? input.remove
        ? "task.parent.clear"
        : "task.parent.set"
      : input.relation === "related"
        ? input.remove
          ? "task.unlink"
          : "task.link"
        : input.remove
          ? "task.dependency.remove"
          : "task.dependency.add";
  const fields =
    input.relation === "parent"
      ? input.remove
        ? {}
        : { parent: input.target }
      : { target: input.target };
  return request(async () =>
    savedTask(
      await writeCommand(
        project,
        { op, ref: reference, ifRevision: input.ifRevision, input: fields },
        input.requestId,
      ),
    ),
  );
}
