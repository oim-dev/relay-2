import {
  APPLICATION_TYPES,
  DOCUMENT_KINDS,
  DOCUMENT_STATUSES,
  DOCUMENT_RELATION_TYPES,
  IMPLEMENTATION_STATUSES,
  KNOWLEDGE_KINDS,
  type EntityPageRequest,
  type KnowledgeKind,
} from "@relay/contracts";
import type { Args } from "gunshi";
import {
  choice,
  flag,
  inputArgs,
  jsonArgs,
  pageArgs,
  positional,
  refArgs,
  repeated,
  string,
  textArgs,
} from "../../input/arguments";
import { onlyFields } from "../../input/input";
import { CliUsageError } from "../../errors/errors";
import { knowledgeCommandMessages as messages } from "../../locales/commands/knowledge";
import { result } from "../../output/output";
import type { Result } from "../../output/output.types";
import type { CommandRegistry } from "../../execution/registry";

const common: Args = { name: string(messages.fields.name), ...textArgs("summary", "description") };
const fields: Record<KnowledgeKind, Args> = {
  project: { ...textArgs("name"), slug: string(messages.fields.projectSlug) },
  product: common,
  feature: common,
  scenario: {
    name: string(messages.fields.name),
    feature: string(messages.fields.feature),
    ...textArgs("summary", "description"),
  },
  application: {
    ...common,
    slug: string(messages.fields.applicationSlug),
    prefix: string(messages.fields.boardPrefix),
    type: choice(messages.fields.applicationType, [...APPLICATION_TYPES]),
  },
  implementation: {
    title: string(messages.fields.title),
    application: string(messages.fields.application),
    target: string(messages.fields.requirementTarget),
    status: choice(messages.fields.implementationStatus, [...IMPLEMENTATION_STATUSES]),
    ...textArgs("description"),
  },
  document: {
    name: string(messages.fields.name),
    ...textArgs("summary", "body"),
    "document-kind": choice(messages.fields.documentKind, [...DOCUMENT_KINDS]),
    "document-status": choice(messages.fields.documentStatus, [...DOCUMENT_STATUSES]),
    "section-id": string(messages.fields.sectionId),
    pinned: flag(messages.fields.pinned),
    targets: repeated(messages.fields.documentTarget),
    ...jsonArgs("relations", messages.fields.documentRelations),
  },
  board: {},
};
const createOnlyFields: Partial<Record<KnowledgeKind, readonly string[]>> = {
  scenario: ["feature"],
  application: ["slug", "prefix"],
  implementation: ["application", "target"],
};
const createInputAliases: Partial<Record<KnowledgeKind, readonly string[]>> = {
  scenario: ["featureId"],
  implementation: ["applicationId"],
};
const listSorts = [
  "key",
  "title",
  "updated",
] as const satisfies readonly EntityPageRequest["sort"][];

/**
 * Возвращает описание фильтров CLI для выбранного вида знаний.
 * Фильтрацию записей и проверку допустимых значений выполняет Core при вызове команды.
 */
function knowledgeListFields(kind: KnowledgeKind): Args {
  return {
    q: string(messages.fields.query),
    ...(kind === "scenario" ? { feature: string(messages.fields.feature) } : {}),
    ...(kind === "implementation"
      ? {
          status: string(messages.fields.status),
          application: string(messages.fields.application),
          target: string(messages.fields.target),
          active: flag(messages.fields.active),
        }
      : {}),
    ...(kind === "document"
      ? {
          status: string(messages.fields.status),
          target: string(messages.fields.target),
          "section-id": string(messages.fields.section),
          "document-kind": string(messages.fields.documentKind),
          pinned: flag(messages.fields.pinnedFilter),
        }
      : {}),
  };
}

/**
 * Возвращает проверенный порядок списка CLI либо отклоняет неизвестное значение.
 */
function readKnowledgeSort(value: string): EntityPageRequest["sort"] {
  const sort = listSorts.find((candidate) => candidate === value);
  if (sort === undefined) {
    throw new CliUsageError(messages.unknownSort);
  }
  return sort;
}

/**
 * Возвращает схему полей операции с разделом; удаление не принимает дополнительных полей.
 */
function documentSectionFields(action: "create" | "update" | "move" | "remove"): Args {
  if (action === "create" || action === "update") {
    return inputArgs(textArgs("name"));
  }
  if (action === "move") {
    return {
      before: string(messages.fields.beforeSection),
      last: flag(messages.fields.lastSection),
    };
  }
  return {};
}

/**
 * Возвращает массив пользовательских ссылок из ввода полной замены участия.
 * Пустой массив допустим; неизвестные поля и иная форма targets вызывают ошибку CLI.
 * Ссылки и предметные ограничения состава проверяет Core, входной объект не изменяется.
 */
function readParticipationTargets(input: Readonly<Record<string, unknown>>): string[] {
  onlyFields(input, ["targets"]);
  if (!Array.isArray(input.targets) || !input.targets.every((item) => typeof item === "string")) {
    throw new CliUsageError(messages.participationTargetsRequired);
  }
  return input.targets;
}

/**
 * Добавляет команды знаний и вложенных составов в реестр без чтения проекта.
 * Обработчики передают мутации Core; реестр охватывает запись транзакцией, а чтение — снимком.
 */
export function registerKnowledgeCommands(registry: CommandRegistry): void {
  for (const kind of KNOWLEDGE_KINDS) {
    const singleton = kind === "project" || kind === "product";
    const immutable = createOnlyFields[kind] ?? [];
    const updateFields = Object.fromEntries(
      Object.entries(fields[kind]).filter(([field]) => !immutable.includes(field)),
    );
    registry.group(kind, messages.groups[kind]);
    registry.add(`${kind} get`, {
      description: messages.get[kind],
      args: singleton ? {} : refArgs,
      /**
       * Возвращает полную запись; для единственного паспорта Core выбирает ссылку сам.
       */
      run: (i): Result => result(i.knowledge.get(kind, singleton ? undefined : i.text("ref"))),
    });
    if (!singleton) {
      registry.add(`${kind} list`, {
        description: messages.list[kind],
        args: { ...pageArgs, sort: choice(messages.fields.sort, [...listSorts], "key") },
        fields: knowledgeListFields(kind),
        /**
         * Возвращает страницу выбранного вида; Core определяет состав и стоимость фильтрации.
         */
        run: (i): Result => {
          const sort = readKnowledgeSort(i.text("sort"));
          return i.page((window) => i.knowledge.listPage(kind, i.input, { ...window, sort }));
        },
      });
    }
    if (kind !== "project" && kind !== "board") {
      registry.add(`${kind} create`, {
        description: messages.create[kind],
        mode: "create",
        fields: inputArgs(fields[kind], createInputAliases[kind] ?? []),
        /**
         * Возвращает запись, созданную Core атомарно вместе с её обязательными связанными данными.
         */
        run: (i): Result => result(i.knowledge.create(kind, i.input, i.actor)),
      });
    }
    if (kind !== "board") {
      registry.add(`${kind} update`, {
        description: messages.update[kind],
        mode: "update",
        args: singleton ? {} : refArgs,
        fields: inputArgs(updateFields),
        /**
         * Возвращает запись после изменения полей; Core проверяет её ревизию до no-op.
         */
        run: (i): Result =>
          result(i.knowledge.update(kind, singleton ? undefined : i.text("ref"), i.input, i.write)),
      });
    }
    registry.add(`${kind} rename`, {
      description: messages.rename,
      mode: "update",
      args: { ...(singleton ? {} : refArgs), key: positional(messages.fields.key) },
      /**
       * Возвращает запись с изменённым ключом; Core сохраняет ID и алиасы под CAS записи.
       * Поиск единственного паспорта остаётся в общей транзакции переименования.
       */
      run: (i): Result =>
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

  registry.group("document section", messages.section);
  registry.add("document section list", {
    description: messages.sectionList,
    args: pageArgs,
    /**
     * Возвращает страницу полного списка разделов с ревизией проекта из снимка команды.
     */
    run: (i): Result => {
      const { items, ...owner } = i.knowledge.documentSections();
      return i.page(items, owner);
    },
  });
  for (const action of ["create", "update", "move", "remove"] as const) {
    registry.add(`document section ${action}`, {
      description: messages.sectionActions[action],
      mode: "update",
      args: { id: positional(messages.fields.sectionId) },
      fields: documentSectionFields(action),
      /**
       * Возвращает проект после изменения раздела; ревизия принадлежит проекту.
       * CLI проверяет выбор --before/--last, а Core — атомарность, CAS и no-op.
       */
      run: (i): Result => {
        if (action === "move" && Boolean(i.input.before) === Boolean(i.input.last)) {
          throw new CliUsageError(messages.sectionDestinationRequired);
        }
        return result(i.knowledge.changeSection(action, { ...i.input, id: i.text("id") }, i.write));
      },
    });
  }
  for (const remove of [false, true]) {
    registry.add(`document ${remove ? "unlink" : "link"}`, {
      description: remove ? messages.unlink : messages.link,
      mode: "update",
      args: {
        ...refArgs,
        target: string(messages.fields.relationTarget, true),
        relation: choice(messages.fields.relationType, [...DOCUMENT_RELATION_TYPES], "documents"),
      },
      fields: remove ? {} : textArgs("description"),
      /**
       * Возвращает документ после изменения связи под его исходной ревизией.
       * Core разрешает цель, проверяет её допустимость и обрабатывает no-op атомарно.
       */
      run: (i): Result =>
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
  }
  registry.add("document links", {
    description: messages.links,
    args: { ...refArgs, ...pageArgs },
    /**
     * Возвращает страницу полного набора связей и ревизию документа из одного снимка.
     */
    run: (i): Result => {
      const { items, ...owner } = i.knowledge.documentLinks(i.text("ref"));
      return i.page(items, owner);
    },
  });
  registry.group("application participation", messages.participation);
  registry.add("application participation list", {
    description: messages.participationList,
    args: { ...refArgs, ...pageArgs },
    /**
     * Возвращает страницу активного участия и ревизию приложения из снимка команды.
     * Core фильтрует реализации; весь состав загружается до пагинации.
     */
    run: (i): Result => {
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
    description: messages.participationReplace,
    mode: "update",
    args: refArgs,
    fields: inputArgs({ targets: repeated(messages.fields.requirementTarget) }),
    /**
     * Возвращает приложение после полной замены участия, включая явное опустошение состава.
     * Core атомарно меняет реализации и состав под CAS приложения, проверяемым до no-op.
     */
    run: (i): Result => {
      const targets = readParticipationTargets(i.input);
      return result(i.knowledge.replaceParticipation(i.text("ref"), targets, i.write));
    },
  });
}
