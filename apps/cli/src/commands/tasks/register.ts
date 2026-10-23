import { TASK_COLUMNS } from "@relay/contracts";
import {
  choice,
  inputArgs,
  jsonArgs,
  pageArgs,
  positional,
  refArgs,
  repeated,
  string,
  textArgs,
} from "../../input/arguments";
import { onlyFields, requiredText } from "../../input/input";
import { CliUsageError } from "../../errors/errors";
import { taskCommandMessages as messages } from "../../locales/commands/tasks";
import { result } from "../../output/output";
import type { Result } from "../../output/output.types";
import type { CommandRegistry } from "../../execution/registry";
import type { TaskCommentInput } from "./input.types";

const content = {
  title: string(messages.fields.title),
  ...textArgs({ description: messages.fields.description }),
  targets: repeated(messages.fields.target),
};

/**
 * Возвращает поля комментария после проверки формы CLI, не изменяя входной объект.
 * Неизвестные поля, нестроковый заголовок и пустое тело отклоняются до вызова Core.
 */
function readTaskCommentInput(input: Readonly<Record<string, unknown>>): TaskCommentInput {
  onlyFields(input, ["body", "title"]);
  const title = input.title;
  if (title !== undefined && typeof title !== "string") {
    throw new CliUsageError(messages.invalidCommentTitle);
  }
  return { body: requiredText(input, "body"), title };
}

/**
 * Добавляет в реестр команды задач и вложенных данных без открытия проекта.
 * Core владеет предметными проверками и CAS задачи; реестр сохраняет общую транзакцию
 * записи либо снимок чтения для каждого обработчика.
 */
export function registerTaskCommands(registry: CommandRegistry): void {
  registry.group("task", messages.task);
  registry.add("task list", {
    ...messages.list,
    args: pageArgs,
    fields: {
      board: string(messages.fields.board),
      column: choice(messages.fields.column, [...TASK_COLUMNS]),
      parent: string(messages.fields.parent),
      q: string(messages.fields.query),
      "search-in": choice(messages.fields.searchIn, ["title", "all"]),
      "product-target": string(messages.fields.productTarget),
      completion: choice(messages.fields.completion, ["unfinished", "finished"]),
      readiness: choice(messages.fields.readiness, ["blocked", "ready"]),
    },
    /**
     * Возвращает страницу задач по ключу; состав и стоимость фильтрации определяет Core.
     */
    run: (i): Result => i.page((window) => i.tasks.listPage(i.input, { ...window, sort: "key" })),
  });
  registry.add("task get", {
    ...messages.get,
    args: refArgs,
    /**
     * Возвращает полную карточку задачи по ссылке, разрешённой Core.
     */
    run: (i): Result => result(i.tasks.get(i.text("ref"))),
  });
  registry.add("task create", {
    ...messages.create,
    mode: "create",
    fields: inputArgs({
      ...content,
      board: string(messages.fields.board),
      column: choice(messages.fields.initialColumn, [...TASK_COLUMNS]),
      parent: string(messages.fields.parent),
      dependencies: repeated(messages.fields.dependency),
      related: repeated(messages.fields.related),
      ...jsonArgs("acceptance-criteria", messages.fields.acceptanceCriteria),
    }),
    /**
     * Возвращает задачу, атомарно созданную Core вместе с критериями и связями.
     */
    run: (i): Result => result(i.tasks.create(i.input, i.actor)),
  });
  registry.add("task update", {
    ...messages.update,
    mode: "update",
    args: refArgs,
    fields: inputArgs(content),
    /**
     * Возвращает задачу после изменения содержания; Core проверяет её ревизию до no-op.
     */
    run: (i): Result => result(i.tasks.update(i.text("ref"), i.input, i.write)),
  });
  registry.add("task move", {
    ...messages.move,
    mode: "update",
    args: refArgs,
    fields: inputArgs({
      column: choice(messages.fields.column, [...TASK_COLUMNS]),
      board: string(messages.fields.newBoard),
    }),
    /**
     * Возвращает перемещённую задачу; атомарность, CAS и no-op обеспечивает Core.
     */
    run: (i): Result => result(i.tasks.move(i.text("ref"), i.input, i.write)),
  });
  registry.add("task progress", {
    ...messages.progress,
    args: refArgs,
    /**
     * Возвращает рассчитанные Core обязательства и блокеры задачи в снимке команды.
     */
    run: (i): Result => result(i.tasks.progress(i.text("ref"))),
  });
  registry.add("task children", {
    ...messages.children,
    args: { ...refArgs, ...pageArgs },
    /**
     * Возвращает страницу прямых детей; разрешение родителя и фильтрация принадлежат Core.
     */
    run: (i): Result =>
      i.page((window) => i.tasks.listPage({ parent: i.text("ref") }, { ...window, sort: "key" })),
  });
  registry.group("task parent", messages.parent);
  for (const clear of [false, true]) {
    registry.add(`task parent ${clear ? "clear" : "set"}`, {
      ...(clear ? messages.parentClear : messages.parentSet),
      mode: "update",
      args: { ...refArgs, ...(clear ? {} : { parent: positional(messages.fields.parentTask) }) },
      /**
       * Возвращает задачу после установки или снятия родителя под её исходной ревизией.
       * Проверки графа и сохранение no-op выполняет Core в транзакции команды.
       */
      run: (i): Result =>
        result(i.tasks.setParent(i.text("ref"), clear ? null : i.text("parent"), i.write)),
    });
  }
  registry.group("task dependency", messages.dependency);
  registry.add("task dependency list", {
    ...messages.dependencyList,
    args: { ...refArgs, ...pageArgs },
    /**
     * Возвращает страницу зависимостей и ревизию владельца из общего снимка команды.
     * Полный список зависимостей читается до пагинации.
     */
    run: (i): Result => {
      const { task, revision, items } = i.tasks.dependenciesWithOwner(i.text("ref"));
      return i.page(items, { ref: task, revision });
    },
  });
  for (const remove of [false, true]) {
    registry.add(`task dependency ${remove ? "remove" : "add"}`, {
      ...(remove ? messages.dependencyRemove : messages.dependencyAdd),
      mode: "update",
      args: { ...refArgs, target: positional(messages.fields.dependencyTask) },
      /**
       * Возвращает задачу после изменения зависимости; CAS, граф и no-op проверяет Core.
       */
      run: (i): Result =>
        result(i.tasks.dependency(i.text("ref"), i.text("target"), remove, i.write)),
    });
  }
  registry.group("task criterion", messages.criterion);
  registry.add("task criterion list", {
    ...messages.criterionList,
    args: { ...refArgs, ...pageArgs },
    /**
     * Возвращает страницу полного набора критериев и ревизию задачи из одного снимка.
     */
    run: (i): Result => {
      const { task, revision, items } = i.tasks.criteriaWithOwner(i.text("ref"));
      return i.page(items, { ref: task, revision });
    },
  });
  registry.add("task criterion get", {
    ...messages.criterionGet,
    args: { ...refArgs, criterion: positional(messages.fields.criterionId) },
    /**
     * Возвращает критерий с ключом и ревизией его задачи из снимка команды.
     */
    run: (i): Result => result(i.tasks.getCriterionWithOwner(i.text("ref"), i.text("criterion"))),
  });
  for (const action of ["add", "update", "complete", "reopen", "remove"] as const) {
    registry.add(`task criterion ${action}`, {
      ...messages.criterionActions[action],
      mode: "update",
      args: {
        ...refArgs,
        ...(action === "add" ? {} : { criterion: positional(messages.fields.criterionId) }),
      },
      fields:
        action === "add" || action === "update"
          ? inputArgs({
              title: string(messages.fields.heading),
              ...textArgs({
                summary: messages.fields.criterionSummary,
                description: messages.fields.criterionDescription,
              }),
            })
          : {},
      /**
       * Возвращает задачу после изменения критерия под ревизией задачи.
       * Core атомарно проверяет состояние, исходную ревизию и возможность no-op.
       */
      run: (i): Result =>
        result(
          i.tasks.criterion(
            i.text("ref"),
            action,
            { ...i.input, ...(action === "add" ? {} : { id: i.text("criterion") }) },
            i.write,
          ),
        ),
    });
  }
  registry.group("task comment", messages.comment);
  registry.add("task comment list", {
    ...messages.commentList,
    presentation: "task-comments",
    args: { ...refArgs, ...pageArgs },
    /**
     * Возвращает страницу полного журнала комментариев и ревизию задачи из одного снимка.
     */
    run: (i): Result => {
      const { task, revision, items } = i.tasks.commentsWithOwner(i.text("ref"));
      return i.page(items, { task, revision });
    },
  });
  registry.add("task comment get", {
    ...messages.commentGet,
    args: { ...refArgs, comment: positional(messages.fields.commentId) },
    /**
     * Возвращает комментарий указанной задачи по его постоянному ID.
     */
    run: (i): Result => result(i.tasks.getComment(i.text("ref"), i.text("comment"))),
  });
  registry.add("task comment add", {
    ...messages.commentAdd,
    mode: "create",
    args: refArgs,
    fields: inputArgs({
      title: string(messages.fields.commentTitle),
      ...textArgs({ body: messages.fields.commentBody }),
    }),
    /**
     * Публикует новый комментарий и возвращает задачу с дополненным журналом.
     * Запись Core атомарна и не меняет ревизию содержания задачи; повтор создаёт новую запись.
     */
    run: (i): Result => {
      const input = readTaskCommentInput(i.input);
      return result(i.tasks.comment(i.text("ref"), input.body, i.actor, input.title));
    },
  });
  for (const remove of [false, true]) {
    registry.add(`task ${remove ? "unlink" : "link"}`, {
      ...(remove ? messages.unlink : messages.link),
      mode: "update",
      args: { ...refArgs, target: positional(messages.fields.related) },
      /**
       * Возвращает задачу после изменения обычной связи; CAS и no-op принадлежат Core.
       */
      run: (i): Result => result(i.tasks.related(i.text("ref"), i.text("target"), remove, i.write)),
    });
  }
}
