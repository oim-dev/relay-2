/**
 * Разбор фильтров и предикаты над проверенными знаниями; запись и загрузка набора не выполняются.
 */
import {
  APPLICATION_TYPES,
  DOCUMENT_KINDS,
  DOCUMENT_STATUSES,
  IMPLEMENTATION_STATUSES,
  type KnowledgeKind,
  type KnowledgeRecord,
} from "@relay/contracts";
import type {
  KnowledgeFilters,
  KnowledgeReferenceConstraint,
  KnowledgeReferenceFilter,
  ResolvedKnowledgeFilters,
} from "./knowledge-filters.types";
import type { KnowledgeInput, KnowledgeResolver } from "./knowledge.types";
import { knowledgeMessages } from "./knowledge.messages";
import { requireImplementationTarget } from "./knowledge-rules";
import {
  knowledgeAlias,
  knowledgeBoolean,
  knowledgeChoice,
  knowledgeFields,
  knowledgeText,
} from "./knowledge-validation";

const filterFields = {
  project: [],
  product: [],
  feature: [],
  scenario: ["feature", "featureId"],
  application: ["type"],
  implementation: [
    "application",
    "applicationId",
    "feature",
    "featureId",
    "scenario",
    "scenarioId",
    "target",
    "active",
    "status",
  ],
  document: [
    "target",
    "section",
    "sectionId",
    "documentKind",
    "documentStatus",
    "status",
    "pinned",
    "archived",
  ],
  board: ["application", "applicationId"],
} as const;

/**
 * Разбирает альтернативные имена ссылочных ограничений без обращения к БД.
 */
function referenceFilters(input: KnowledgeInput): KnowledgeReferenceFilter[] {
  const result: KnowledgeReferenceFilter[] = [];
  for (const kind of ["application", "feature", "scenario"] as const) {
    const alias = `${kind}Id`;
    if (Object.hasOwn(input, kind) || Object.hasOwn(input, alias)) {
      result.push({ kind, ref: knowledgeText(knowledgeAlias(input, kind, alias), kind, true) });
    }
  }
  return result;
}

/**
 * Различает отсутствие раздела, пользовательское section:none и буквальный sectionId.
 */
function sectionFilter(input: KnowledgeInput): string | null {
  const value = knowledgeAlias(input, "section", "sectionId");
  if (value === null || (!Object.hasOwn(input, "sectionId") && value === "none")) {
    return null;
  }
  return knowledgeText(value, "section", true);
}

/**
 * Проверяет допустимые фильтры выбранного вида; сырые поля дальше не передаются.
 */
export function parseKnowledgeFilters(kind: KnowledgeKind, value: unknown): KnowledgeFilters {
  const input = knowledgeFields(
    value,
    ["q", "sort", ...filterFields[kind]],
    knowledgeMessages.filtersLabel,
  );
  let status: KnowledgeFilters["status"];
  if (Object.hasOwn(input, "status") || Object.hasOwn(input, "documentStatus")) {
    status = knowledgeChoice(
      knowledgeAlias(input, "status", "documentStatus"),
      kind === "document" ? DOCUMENT_STATUSES : IMPLEMENTATION_STATUSES,
      "status",
    );
  }
  return {
    sort: Object.hasOwn(input, "sort")
      ? knowledgeChoice(input.sort, ["key", "title", "updated"], "sort")
      : "key",
    references: referenceFilters(input),
    ...(Object.hasOwn(input, "q")
      ? { query: knowledgeText(input.q, "q").toLocaleLowerCase() }
      : {}),
    ...(Object.hasOwn(input, "target")
      ? { target: knowledgeText(input.target, "target", true) }
      : {}),
    ...(Object.hasOwn(input, "active") ? { active: knowledgeBoolean(input.active, "active") } : {}),
    ...(Object.hasOwn(input, "pinned") ? { pinned: knowledgeBoolean(input.pinned, "pinned") } : {}),
    ...(Object.hasOwn(input, "type")
      ? { type: knowledgeChoice(input.type, APPLICATION_TYPES, "type") }
      : {}),
    ...(Object.hasOwn(input, "documentKind")
      ? { documentKind: knowledgeChoice(input.documentKind, DOCUMENT_KINDS, "documentKind") }
      : {}),
    ...(status === undefined ? {} : { status }),
    ...(Object.hasOwn(input, "archived")
      ? { archived: knowledgeBoolean(input.archived, "archived") }
      : {}),
    ...(Object.hasOwn(input, "section") || Object.hasOwn(input, "sectionId")
      ? { sectionId: sectionFilter(input) }
      : {}),
  };
}

/**
 * Получает имя для сортировки, учитывая незаполненный паспорт продукта.
 */
function knowledgeDisplayName(record: KnowledgeRecord): string {
  return record.kind === "implementation" ? record.data.title : (record.data.name ?? "");
}

/**
 * Проверяет подстроку по адресам и всем доступным текстовым полям записи.
 */
function matchesQuery(record: KnowledgeRecord, query: string): boolean {
  const data = record.data;
  return [
    record.id,
    record.key,
    knowledgeDisplayName(record),
    "summary" in data ? data.summary : undefined,
    "description" in data ? data.description : undefined,
    "body" in data ? data.body : undefined,
  ].some((value) => typeof value === "string" && value.toLocaleLowerCase().includes(query));
}

/**
 * Разрешает ссылки один раз в снимке для последующей чистой фильтрации записей.
 * Вызывающий удерживает снимок до завершения фильтрации полного набора.
 */
export function resolveKnowledgeFilters(
  kind: KnowledgeKind,
  filters: KnowledgeFilters,
  reader: KnowledgeResolver,
): ResolvedKnowledgeFilters {
  const { references, target, ...attributes } = filters;
  const resolved = references.map((reference) => ({
    kind: reference.kind,
    id: reader.resolve(reference.ref, reference.kind).id,
  }));
  let targetId: string | undefined;
  if (target !== undefined) {
    const record = reader.resolve(target);
    targetId = kind === "implementation" ? requireImplementationTarget(record).id : record.id;
  }
  return { ...attributes, references: resolved, ...(targetId === undefined ? {} : { targetId }) };
}

/**
 * Сравнивает сохранённую ссылку с постоянным ID без обращения к хранилищу.
 */
function matchesReference(
  record: KnowledgeRecord,
  constraint: KnowledgeReferenceConstraint,
): boolean {
  switch (constraint.kind) {
    case "application":
      return "applicationId" in record.data && record.data.applicationId === constraint.id;
    case "feature":
      return "featureId" in record.data && record.data.featureId === constraint.id;
    case "scenario":
      return "scenarioId" in record.data && record.data.scenarioId === constraint.id;
  }
}

/**
 * Проверяет запись по разрешённым фильтрам; документ уже имеет эффективный раздел снимка.
 */
export function matchesKnowledge(
  record: KnowledgeRecord,
  filters: ResolvedKnowledgeFilters,
): boolean {
  if (filters.query !== undefined && !matchesQuery(record, filters.query)) {
    return false;
  }
  if (!filters.references.every((constraint) => matchesReference(record, constraint))) {
    return false;
  }
  if (filters.targetId !== undefined) {
    const matchesTarget =
      record.kind === "document"
        ? record.data.relations.some((relation) => relation.target.id === filters.targetId)
        : record.kind === "implementation" && record.data.targetId === filters.targetId;
    if (!matchesTarget) {
      return false;
    }
  }
  if (
    filters.active !== undefined &&
    (record.kind !== "implementation" || record.data.active !== filters.active)
  ) {
    return false;
  }
  if (
    filters.type !== undefined &&
    (record.kind !== "application" || record.data.type !== filters.type)
  ) {
    return false;
  }
  if (
    filters.status !== undefined &&
    !(
      (record.kind === "document" && record.data.documentStatus === filters.status) ||
      (record.kind === "implementation" && record.data.status === filters.status)
    )
  ) {
    return false;
  }
  return matchesDocumentFilters(record, filters);
}

/**
 * Проверяет атрибуты библиотеки документов, отсутствующие у остальных видов знаний.
 */
function matchesDocumentFilters(
  record: KnowledgeRecord,
  filters: ResolvedKnowledgeFilters,
): boolean {
  return (
    (filters.pinned === undefined ||
      (record.kind === "document" && record.data.pinned === filters.pinned)) &&
    (filters.documentKind === undefined ||
      (record.kind === "document" && record.data.documentKind === filters.documentKind)) &&
    (filters.archived === undefined ||
      (record.kind === "document" &&
        (record.data.documentStatus === "archived") === filters.archived)) &&
    (filters.sectionId === undefined ||
      (record.kind === "document" && record.data.sectionId === filters.sectionId))
  );
}

/**
 * Сравнивает знания по выбранному полю, затем по постоянному ID для устойчивого порядка.
 */
export function compareKnowledge(
  left: KnowledgeRecord,
  right: KnowledgeRecord,
  sort: KnowledgeFilters["sort"],
): number {
  let order: number;
  if (sort === "updated") {
    order = right.updatedAt.localeCompare(left.updatedAt);
  } else if (sort === "title") {
    order = knowledgeDisplayName(left).localeCompare(knowledgeDisplayName(right));
  } else {
    order = left.key.localeCompare(right.key);
  }
  return order || left.id.localeCompare(right.id);
}
