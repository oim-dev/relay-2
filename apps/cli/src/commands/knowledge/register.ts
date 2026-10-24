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
  expectedVersionArgs,
} from "../../input/arguments";
import { onlyFields } from "../../input/input";
import type { InputFields } from "../../input/arguments.types";
import { CliUsageError } from "../../errors/errors";
import { knowledgeCommandMessages as messages } from "../../locales/commands/knowledge";
import { result } from "../../output/output";
import type { Result } from "../../output/output.types";
import type { CommandRegistry } from "../../execution/registry";

const common: Args = {
  name: string(messages.fields.name),
  ...textArgs({ summary: messages.fields.summary }),
};
const fields: Record<KnowledgeKind, Args> = {
  project: {
    ...textArgs({ name: messages.fields.projectName }),
    slug: string(messages.fields.projectSlug),
  },
  product: { ...common, ...textArgs({ description: messages.fields.productDescription }) },
  feature: { ...common, ...textArgs({ description: messages.fields.featureDescription }) },
  scenario: {
    ...common,
    feature: string(messages.fields.feature),
    ...textArgs({ description: messages.fields.scenarioDescription }),
  },
  application: {
    ...common,
    ...textArgs({ description: messages.fields.applicationDescription }),
    slug: string(messages.fields.applicationSlug),
    prefix: string(messages.fields.boardPrefix),
    type: choice(messages.fields.applicationType, [...APPLICATION_TYPES]),
  },
  implementation: {
    title: string(messages.fields.title),
    application: string(messages.fields.application),
    target: string(messages.fields.requirementTarget),
    status: choice(messages.fields.implementationStatus, [...IMPLEMENTATION_STATUSES]),
    ...textArgs({ description: messages.fields.implementationDescription }),
  },
  document: {
    name: string(messages.fields.name),
    ...textArgs({ summary: messages.fields.summary, body: messages.fields.documentBody }),
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
    ...(kind === "application"
      ? { type: choice(messages.fields.applicationTypeFilter, [...APPLICATION_TYPES]) }
      : {}),
    ...(kind === "board" ? { application: string(messages.fields.applicationFilter) } : {}),
    ...(kind === "implementation"
      ? {
          status: string(messages.fields.status),
          application: string(messages.fields.application),
          feature: string(messages.fields.implementationFeatureFilter),
          target: string(messages.fields.implementationTargetFilter),
          active: flag(messages.fields.active),
        }
      : {}),
    ...(kind === "document"
      ? {
          status: string(messages.fields.status),
          target: string(messages.fields.target),
          "section-id": string(messages.fields.section),
          "without-section": flag(messages.fields.withoutSection),
          "document-kind": string(messages.fields.documentKind),
          pinned: flag(messages.fields.pinnedFilter),
        }
      : {}),
  };
}

/**
 * Преобразует --without-section в явный null раздела, не изменяя исходный ввод.
 * Значение false отключает этот флаг; true несовместим с любым переданным --section-id.
 * Ссылки, значения и пересечение предметных ограничений проверяет Core.
 */
function readKnowledgeListFilters(input: Readonly<InputFields>): InputFields {
  const { withoutSection, ...filters } = input;
  if (withoutSection === true) {
    if (Object.hasOwn(filters, "sectionId")) {
      throw new CliUsageError(messages.conflictingSectionFilters, "CONFLICTING_OPTIONS");
    }
    return { ...filters, sectionId: null };
  }
  return filters;
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
    return inputArgs(textArgs({ name: messages.fields.sectionName }));
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
 * Writers ожидают commit Core без внешней транзакции; синхронные чтения остаются в снимке реестра.
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
      ...messages.get(kind),
      args: singleton ? {} : refArgs,
      /**
       * Возвращает полную запись; для единственного паспорта Core выбирает ссылку сам.
       */
      run: (i): Result => result(i.knowledge.get(kind, singleton ? undefined : i.text("ref"))),
    });
    if (!singleton) {
      registry.add(`${kind} list`, {
        ...messages.list(kind),
        args: { ...pageArgs, sort: choice(messages.fields.sort, [...listSorts], "key") },
        fields: knowledgeListFields(kind),
        /**
         * Возвращает страницу выбранного вида; Core определяет состав и стоимость фильтрации.
         */
        run: (i): Result => {
          const sort = readKnowledgeSort(i.text("sort"));
          const filters = readKnowledgeListFilters(i.input);
          return i.page((window) => i.knowledge.listPage(kind, filters, { ...window, sort }));
        },
      });
    }
    if (kind !== "project" && kind !== "board") {
      registry.add(`${kind} create`, {
        ...messages.create[kind],
        mode: "create",
        args: kind === "product" || kind === "implementation" ? expectedVersionArgs : {},
        fields: inputArgs(fields[kind], createInputAliases[kind] ?? []),
        /**
         * Возвращает запись, созданную Core атомарно вместе с её обязательными связанными данными.
         */
        run: async (i): Promise<Result> => result(await i.knowledge.create(kind, i.input, i.actor)),
      });
    }
    if (kind !== "board") {
      registry.add(`${kind} update`, {
        ...messages.update[kind],
        mode: "update",
        args: singleton ? {} : refArgs,
        fields: inputArgs(updateFields),
        /**
         * Возвращает запись после изменения полей; Core проверяет её ревизию до no-op.
         */
        run: async (i): Promise<Result> =>
          result(
            await i.knowledge.update(kind, singleton ? undefined : i.text("ref"), i.input, i.write),
          ),
      });
    }
    registry.add(`${kind} rename`, {
      ...messages.rename(kind),
      mode: "update",
      args: { ...(singleton ? {} : refArgs), key: positional(messages.fields.key) },
      /**
       * Возвращает запись с изменённым ключом; Core сохраняет ID и алиасы под CAS записи.
       * Поиск единственного паспорта остаётся в общей транзакции переименования.
       */
      run: async (i): Promise<Result> =>
        result(
          await i.knowledge.rename(
            kind,
            singleton ? undefined : i.text("ref"),
            i.text("key"),
            i.write,
          ),
        ),
    });
  }

  registry.group("document section", messages.section);
  registry.add("document section list", {
    ...messages.sectionList,
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
      ...messages.sectionActions[action],
      mode: "update",
      args: { id: positional(messages.fields.sectionId) },
      fields: documentSectionFields(action),
      /**
       * Возвращает проект после изменения раздела; ревизия принадлежит проекту.
       * CLI проверяет выбор --before/--last, а Core — атомарность, CAS и no-op.
       */
      run: async (i): Promise<Result> => {
        if (action === "move" && Boolean(i.input.before) === Boolean(i.input.last)) {
          throw new CliUsageError(messages.sectionDestinationRequired);
        }
        return result(
          await i.knowledge.changeSection(action, { ...i.input, id: i.text("id") }, i.write),
        );
      },
    });
  }
  for (const remove of [false, true]) {
    registry.add(`document ${remove ? "unlink" : "link"}`, {
      ...(remove ? messages.unlink : messages.link),
      mode: "update",
      args: {
        ...refArgs,
        target: string(messages.fields.relationTarget, true),
        relation: choice(messages.fields.relationType, [...DOCUMENT_RELATION_TYPES], "documents"),
      },
      fields: remove ? {} : textArgs({ description: messages.fields.relationDescription }),
      /**
       * Возвращает документ после изменения связи под его исходной ревизией.
       * Core разрешает цель, проверяет её допустимость и обрабатывает no-op атомарно.
       */
      run: async (i): Promise<Result> =>
        result(
          await i.knowledge.linkDocument(i.text("ref"), i.text("target"), {
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
    ...messages.links,
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
    ...messages.participationList,
    args: { ...refArgs, ...pageArgs },
    /**
     * Возвращает страницу участия и ревизию из одного составного чтения Core без повторного get.
     * История только выбранного приложения фильтруется в Core; активный состав читается до окна.
     */
    run: (i): Result => {
      const { items, ...owner } = i.knowledge.participation(i.text("ref"));
      return i.page(items, owner);
    },
  });
  registry.add("application participation replace", {
    ...messages.participationReplace,
    mode: "update",
    args: refArgs,
    fields: inputArgs({ targets: repeated(messages.fields.requirementTarget) }),
    /**
     * Возвращает приложение после полной замены участия, включая явное опустошение состава.
     * Core атомарно меняет реализации и состав под CAS приложения, проверяемым до no-op.
     */
    run: async (i): Promise<Result> => {
      const targets = readParticipationTargets(i.input);
      return result(await i.knowledge.replaceParticipation(i.text("ref"), targets, i.write));
    },
  });
}
