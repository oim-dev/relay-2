import {
  APPLICATION_TYPES,
  DOCUMENT_KINDS,
  DOCUMENT_STATUSES,
  DOCUMENT_RELATION_TYPES,
  IMPLEMENTATION_STATUSES,
  type EntityKind,
} from "@relay/contracts";
import type { Args } from "gunshi";
import {
  choice,
  flag,
  inputArgs,
  jsonArgs,
  onlyFields,
  pageArgs,
  positional,
  refArgs,
  repeated,
  string,
  textArgs,
} from "../arguments";
import { CliUsageError } from "../errors";
import { type CommandRegistry, result } from "../registry";

const names: Partial<Record<EntityKind, string>> = {
  project: "Паспорт проекта",
  product: "Паспорт продукта",
  feature: "Фичи",
  scenario: "Сценарии",
  application: "Приложения",
  implementation: "Реализации",
  document: "Документы",
  board: "Доски",
};
const common: Args = { name: string("Название"), ...textArgs("summary", "description") };
const fields: Partial<Record<EntityKind, Args>> = {
  project: { ...textArgs("name"), slug: string("Slug проекта") },
  product: common,
  feature: common,
  scenario: {
    name: string("Название"),
    feature: string("Фича"),
    ...textArgs("summary", "description"),
  },
  application: {
    ...common,
    slug: string("Slug приложения"),
    prefix: string("Префикс доски"),
    type: choice("Тип приложения", [...APPLICATION_TYPES]),
  },
  implementation: {
    title: string("Заголовок"),
    application: string("Приложение"),
    target: string("Фича или сценарий"),
    status: choice("Сохранённая отметка", [...IMPLEMENTATION_STATUSES]),
    ...textArgs("description"),
  },
  document: {
    name: string("Название"),
    ...textArgs("summary", "body"),
    "document-kind": choice("Вид документа", [...DOCUMENT_KINDS]),
    "document-status": choice("Состояние документа", [...DOCUMENT_STATUSES]),
    "section-id": string("ID раздела"),
    pinned: flag("Закрепить документ; --pinned=false снимает закрепление"),
    targets: repeated("Цель документа"),
    ...jsonArgs("relations", "JSON-массив связей документа"),
  },
};

export function registerKnowledgeCommands(registry: CommandRegistry): void {
  for (const [kindName, description] of Object.entries(names)) {
    const kind = kindName as EntityKind;
    const singleton = kind === "project" || kind === "product";
    const immutable =
      kind === "scenario"
        ? ["feature"]
        : kind === "application"
          ? ["slug", "prefix"]
          : kind === "implementation"
            ? ["application", "target"]
            : [];
    const updateFields = Object.fromEntries(
      Object.entries(fields[kind] ?? {}).filter(([field]) => !immutable.includes(field)),
    );
    registry.group(kind, description!);
    registry.add(`${kind} get`, {
      description: `Полное содержание: ${description}`,
      args: singleton ? {} : refArgs,
      run: (i) => result(i.knowledge.get(kind, singleton ? undefined : i.text("ref"))),
    });
    if (!singleton)
      registry.add(`${kind} list`, {
        description: `Краткий список: ${description}`,
        args: { ...pageArgs, sort: choice("Порядок", ["key", "title", "updated"], "key") },
        fields: {
          q: string("Поиск по содержанию"),
          ...(kind === "scenario" ? { feature: string("Фича") } : {}),
          ...(kind === "implementation"
            ? {
                status: string("Состояние"),
                application: string("Приложение"),
                target: string("Цель"),
                active: flag("Только активные реализации"),
              }
            : {}),
          ...(kind === "document"
            ? {
                status: string("Состояние"),
                target: string("Цель"),
                "section-id": string("Раздел"),
                "document-kind": string("Вид документа"),
                pinned: flag("Закреплённые документы"),
              }
            : {}),
        },
        run: (i) => {
          const sort = i.text("sort");
          if (sort !== "key" && sort !== "title" && sort !== "updated")
            throw new CliUsageError("Неизвестный порядок списка");
          return i.page((window) => i.knowledge.listPage(kind, i.input, { ...window, sort }));
        },
      });
    if (kind !== "project" && kind !== "board")
      registry.add(`${kind} create`, {
        description: `Создать: ${description}`,
        mode: "create",
        fields: inputArgs(
          fields[kind]!,
          kind === "scenario" ? ["featureId"] : kind === "implementation" ? ["applicationId"] : [],
        ),
        run: (i) => result(i.knowledge.create(kind, i.input, i.actor)),
      });
    if (kind !== "board")
      registry.add(`${kind} update`, {
        description: `Изменить переданные поля: ${description}`,
        mode: "update",
        args: singleton ? {} : refArgs,
        fields: inputArgs(updateFields),
        run: (i) =>
          result(i.knowledge.update(kind, singleton ? undefined : i.text("ref"), i.input, i.write)),
      });
    registry.add(`${kind} rename`, {
      description: "Изменить ключ, сохранив ID и алиасы",
      mode: "update",
      args: { ...(singleton ? {} : refArgs), key: positional("Новый читаемый ключ") },
      run: (i) =>
        result(
          i.knowledge.rename(
            kind,
            singleton ? i.knowledge.get(kind).id : i.text("ref"),
            i.text("key"),
            i.write,
          ),
        ),
    });
  }

  registry.group("document section", "Разделы документов; изменения защищены ревизией проекта");
  registry.add("document section list", {
    description: "Разделы в заданном порядке",
    args: pageArgs,
    run: (i) => {
      const { items, ...owner } = i.knowledge.documentSections();
      return i.page(items, owner);
    },
  });
  for (const action of ["create", "update", "move", "remove"] as const) {
    registry.add(`document section ${action}`, {
      description: `${{ create: "Создать", update: "Переименовать", move: "Переместить", remove: "Удалить" }[action]} раздел`,
      mode: "update",
      args: { id: positional("ID раздела") },
      fields:
        action === "create" || action === "update"
          ? inputArgs(textArgs("name"))
          : action === "move"
            ? { before: string("Поместить перед разделом"), last: flag("Поместить в конец") }
            : {},
      run: (i) => {
        if (action === "move" && Boolean(i.input.before) === Boolean(i.input.last))
          throw new CliUsageError("Укажите ровно один параметр: --before или --last");
        return result(i.knowledge.changeSection(action, { ...i.input, id: i.text("id") }, i.write));
      },
    });
  }
  for (const remove of [false, true])
    registry.add(`document ${remove ? "unlink" : "link"}`, {
      description: remove ? "Снять связь документа" : "Прикрепить документ к сущности",
      mode: "update",
      args: {
        ...refArgs,
        target: string("Цель связи", true),
        relation: choice("Тип связи", [...DOCUMENT_RELATION_TYPES], "documents"),
      },
      fields: remove ? {} : textArgs("description"),
      run: (i) =>
        result(
          i.knowledge.linkDocument(i.text("ref"), i.text("target"), {
            ...i.write,
            remove,
            type: i.text("relation"),
            ...(i.input.description === undefined
              ? {}
              : { description: String(i.input.description) }),
          }),
        ),
    });
  registry.add("document links", {
    description: "Прикрепления документа",
    args: { ...refArgs, ...pageArgs },
    run: (i) => {
      const { items, ...owner } = i.knowledge.documentLinks(i.text("ref"));
      return i.page(items, owner);
    },
  });
  registry.group("application participation", "Участие приложения в требованиях");
  registry.add("application participation list", {
    description: "Состав участия приложения",
    args: { ...refArgs, ...pageArgs },
    run: (i) => {
      const application = i.knowledge.get("application", i.text("ref"));
      return i.page(
        i.knowledge.list("implementation", { application: application.id, active: true }),
        {
          application: application.key,
          revision: application.revision,
        },
      );
    },
  });
  registry.add("application participation replace", {
    description: "Заменить полный набор целей приложения; --input допускает targets: []",
    mode: "update",
    args: refArgs,
    fields: inputArgs({ targets: repeated("Фича или сценарий") }),
    run: (i) => {
      onlyFields(i.input, ["targets"]);
      if (
        !Array.isArray(i.input.targets) ||
        !i.input.targets.every((item) => typeof item === "string")
      )
        throw new CliUsageError("Укажите targets как массив ссылок");
      return result(i.knowledge.replaceParticipation(i.text("ref"), i.input.targets, i.write));
    },
  });
}
