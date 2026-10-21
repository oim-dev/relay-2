import { TASK_COLUMNS } from "@relay/contracts";
import {
  choice,
  inputArgs,
  jsonArgs,
  onlyFields,
  pageArgs,
  positional,
  refArgs,
  repeated,
  requiredText,
  string,
  textArgs,
} from "../arguments";
import { CliUsageError } from "../errors";
import { type CommandRegistry, result } from "../registry";

const content = {
  title: string("Название задачи"),
  ...textArgs("description"),
  targets: repeated("Продуктовая цель"),
};

export function registerTaskCommands(registry: CommandRegistry): void {
  registry.group("task", "Задачи, критерии, обсуждения и зависимости");
  registry.add("task list", {
    description: "Краткий список задач",
    args: pageArgs,
    fields: {
      board: string("Доска"),
      column: choice("Колонка", [...TASK_COLUMNS]),
      parent: string("Родитель"),
      q: string("Поиск по содержанию"),
      "search-in": choice("Область поиска", ["title", "all"]),
      "product-target": string("Продуктовая цель с дочерними требованиями"),
      completion: choice("Завершение", ["unfinished", "finished"]),
      readiness: choice("Готовность", ["blocked", "ready"]),
    },
    run: (i) => i.page((window) => i.tasks.listPage(i.input, { ...window, sort: "key" })),
  });
  registry.add("task get", {
    description: "Полная карточка задачи",
    args: refArgs,
    run: (i) => result(i.tasks.get(i.text("ref"))),
  });
  registry.add("task create", {
    description: "Создать задачу с критериями и связями атомарно",
    mode: "create",
    fields: inputArgs({
      ...content,
      board: string("Доска"),
      column: choice("Начальная колонка", [...TASK_COLUMNS]),
      parent: string("Родитель"),
      dependencies: repeated("Зависимость"),
      related: repeated("Связанная задача"),
      ...jsonArgs("acceptance-criteria", "JSON-массив критериев"),
    }),
    run: (i) => result(i.tasks.create(i.input, i.actor)),
  });
  registry.add("task update", {
    description: "Изменить содержание задачи",
    mode: "update",
    args: refArgs,
    fields: inputArgs(content),
    run: (i) => result(i.tasks.update(i.text("ref"), i.input, i.write)),
  });
  registry.add("task move", {
    description: "Переместить задачу в колонку или на доску",
    mode: "update",
    args: refArgs,
    fields: inputArgs({
      column: choice("Колонка", [...TASK_COLUMNS]),
      board: string("Новая доска"),
    }),
    run: (i) => result(i.tasks.move(i.text("ref"), i.input, i.write)),
  });
  registry.add("task progress", {
    description: "Фактические обязательства и блокеры задачи",
    args: refArgs,
    run: (i) => result(i.tasks.progress(i.text("ref"))),
  });
  registry.add("task children", {
    description: "Прямые дочерние задачи",
    args: { ...refArgs, ...pageArgs },
    run: (i) =>
      i.page((window) => i.tasks.listPage({ parent: i.text("ref") }, { ...window, sort: "key" })),
  });
  registry.group("task parent", "Родитель задачи");
  for (const clear of [false, true])
    registry.add(`task parent ${clear ? "clear" : "set"}`, {
      description: clear ? "Снять родителя" : "Назначить родителя",
      mode: "update",
      args: { ...refArgs, ...(clear ? {} : { parent: positional("Родительская задача") }) },
      run: (i) =>
        result(i.tasks.setParent(i.text("ref"), clear ? null : i.text("parent"), i.write)),
    });
  registry.group("task dependency", "Обязательные зависимости задачи");
  registry.add("task dependency list", {
    description: "Прямые зависимости задачи",
    args: { ...refArgs, ...pageArgs },
    run: (i) => {
      const task = i.tasks.get(i.text("ref"));
      return i.page(i.tasks.dependencies(task.id), { ref: task.key, revision: task.revision });
    },
  });
  for (const remove of [false, true])
    registry.add(`task dependency ${remove ? "remove" : "add"}`, {
      description: remove ? "Снять зависимость" : "Добавить обязательную зависимость",
      mode: "update",
      args: { ...refArgs, target: positional("Задача-зависимость") },
      run: (i) => result(i.tasks.dependency(i.text("ref"), i.text("target"), remove, i.write)),
    });
  registry.group("task criterion", "Критерии; ревизия относится к задаче");
  registry.add("task criterion list", {
    description: "Критерии задачи",
    args: { ...refArgs, ...pageArgs },
    run: (i) => {
      const task = i.tasks.get(i.text("ref"));
      return i.page(i.tasks.criteria(task.id), { ref: task.key, revision: task.revision });
    },
  });
  registry.add("task criterion get", {
    description: "Полное содержание критерия",
    args: { ...refArgs, criterion: positional("ID критерия") },
    run: (i) => {
      const task = i.tasks.get(i.text("ref"));
      return result({
        task: task.key,
        revision: task.revision,
        criterion: i.tasks.getCriterion(task.id, i.text("criterion")),
      });
    },
  });
  for (const action of ["add", "update", "complete", "reopen", "remove"] as const)
    registry.add(`task criterion ${action}`, {
      description: {
        add: "Добавить критерий",
        update: "Изменить критерий",
        complete: "Отметить выполнение",
        reopen: "Снять отметку выполнения",
        remove: "Удалить критерий",
      }[action],
      mode: "update",
      args: { ...refArgs, ...(action === "add" ? {} : { criterion: positional("ID критерия") }) },
      fields:
        action === "add" || action === "update"
          ? inputArgs({ title: string("Заголовок"), ...textArgs("summary", "description") })
          : {},
      run: (i) =>
        result(
          i.tasks.criterion(
            i.text("ref"),
            action,
            { ...i.input, ...(action === "add" ? {} : { id: i.text("criterion") }) },
            i.write,
          ),
        ),
    });
  registry.group("task comment", "Неизменяемые комментарии задачи");
  registry.add("task comment list", {
    description: "Комментарии задачи",
    args: { ...refArgs, ...pageArgs },
    run: (i) => {
      const task = i.tasks.get(i.text("ref"));
      return i.page(i.tasks.comments(task.id), { task: task.key, revision: task.revision });
    },
  });
  registry.add("task comment get", {
    description: "Полный комментарий",
    args: { ...refArgs, comment: positional("ID комментария") },
    run: (i) => result(i.tasks.getComment(i.text("ref"), i.text("comment"))),
  });
  registry.add("task comment add", {
    description: "Опубликовать комментарий",
    mode: "create",
    args: refArgs,
    fields: inputArgs({ title: string("Заголовок"), ...textArgs("body") }),
    run: (i) => {
      onlyFields(i.input, ["body", "title"]);
      const title = i.input.title;
      if (title !== undefined && typeof title !== "string")
        throw new CliUsageError("title должен быть строкой");
      return result(i.tasks.comment(i.text("ref"), requiredText(i.input, "body"), i.actor, title));
    },
  });
  for (const remove of [false, true])
    registry.add(`task ${remove ? "unlink" : "link"}`, {
      description: remove
        ? "Снять обычную связь задач"
        : "Связать задачи без обязательной зависимости",
      mode: "update",
      args: { ...refArgs, target: positional("Связанная задача") },
      run: (i) => result(i.tasks.related(i.text("ref"), i.text("target"), remove, i.write)),
    });
}
