import {
  ENTITY_KINDS,
  ENTITY_PAGE_SIZE,
  ENTITY_PAGE_SORTS,
  ENTITY_READ_SIZE,
  TASK_COLUMNS,
} from "@relay/contracts";
import type { ParameterObject, SchemaObject } from "@nestjs/swagger";
import type { HttpOperationName } from "../../src/http/operations.types";

const text: SchemaObject = { type: "string" };
const boolean: SchemaObject = { type: "boolean" };
const integer: SchemaObject = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const taskViewFields: Readonly<Record<string, SchemaObject>> = {
  offset: { ...integer, default: 0 },
  limit: {
    type: "integer",
    minimum: ENTITY_PAGE_SIZE.min,
    maximum: ENTITY_PAGE_SIZE.max,
    default: 40,
  },
  sort: { type: "string", enum: [...ENTITY_PAGE_SORTS], default: "key" },
  generation: { ...integer, description: "Исходное поколение; обязательно при offset > 0." },
  ref: text,
  board: text,
  column: { type: "string", enum: [...TASK_COLUMNS] },
  parentId: text,
  q: text,
  refs: {
    type: "array",
    items: text,
    minItems: ENTITY_READ_SIZE.min,
    maxItems: ENTITY_READ_SIZE.max,
  },
  target: text,
  productTarget: text,
  searchIn: { type: "string", enum: ["title", "all"] },
  completion: { type: "string", enum: ["finished", "unfinished"] },
  readiness: { type: "string", enum: ["ready", "blocked"] },
};

/**
 * Описывает query реально существующих readers. Пути и методы здесь не регистрируются;
 * специфичные допустимые сочетания фильтров сохраняют владельцев в Core.
 */
export function queryParameters(operation: HttpOperationName): ParameterObject[] {
  const fields: Partial<Record<HttpOperationName, Readonly<Record<string, SchemaObject>>>> = {
    taskViews: taskViewFields,
    taskCandidates: { ...taskViewFields, plan: text, stageId: text, availableOnly: boolean },
    entity: {
      ref: {
        ...text,
        minLength: 1,
        description:
          "Одиночный исходный адрес Core; повторы запрещены, '.' и '..' сохраняются дословно.",
      },
      withVersions: boolean,
    },
    receipt: {
      operationKey: {
        ...text,
        minLength: 1,
        description: "Исходный ключ доставки; '.' и '..' сохраняются дословно.",
      },
    },
    entities: {
      kind: { type: "string", enum: [...ENTITY_KINDS] },
      offset: { ...integer, default: 0 },
      limit: {
        type: "integer",
        minimum: ENTITY_PAGE_SIZE.min,
        maximum: ENTITY_PAGE_SIZE.max,
        default: 40,
      },
      sort: { type: "string", enum: [...ENTITY_PAGE_SORTS], default: "key" },
      generation: {
        ...integer,
        description: "Обязателен при offset > 0; исходное поколение страницы.",
      },
      q: text,
      status: text,
      documentStatus: text,
      documentKind: text,
      section: text,
      sectionId: text,
      target: text,
      productTarget: text,
      application: text,
      applicationId: text,
      feature: text,
      featureId: text,
      scenario: text,
      type: text,
      active: boolean,
      pinned: boolean,
      archived: boolean,
      board: text,
      column: text,
      parent: text,
      parentId: text,
      root: boolean,
      unfinished: boolean,
      actor: text,
      readiness: text,
      completion: text,
      searchIn: text,
      session: text,
    },
    search: { q: text, kind: { type: "string", enum: [...ENTITY_KINDS] } },
    getMany: {
      ref: { type: "array", items: text, minItems: 1, maxItems: 200 },
      summary: boolean,
      withVersions: boolean,
    },
    historySessions: {
      status: text,
      parent: text,
      root: boolean,
      unfinished: boolean,
      actor: text,
      q: text,
    },
    historyCheckpoints: { session: text },
    historyTimeline: {
      session: text,
      offset: { ...integer, default: 0 },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
      generation: { ...integer, description: "Исходное поколение; обязательно при offset>0." },
    },
    relationNeighborhood: {
      ref: text,
      component: boolean,
      depth: { type: "integer", minimum: 0, maximum: 100, default: 3 },
      direction: { type: "string", enum: ["both", "incoming", "outgoing"], default: "both" },
      type: text,
      q: text,
      offset: { ...integer, default: 0 },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
      generation: { ...integer, description: "Исходное поколение; обязательно при offset>0." },
    },
    historyIntents: { includeChildren: boolean },
  };
  return Object.entries(fields[operation] ?? {}).map(([name, schema]) => ({
    name,
    in: "query",
    schema,
    required:
      (operation === "entity" && name === "ref") ||
      (operation === "entities" && name === "kind") ||
      (operation === "search" && name === "q") ||
      (operation === "receipt" && name === "operationKey") ||
      (operation === "getMany" && name === "ref"),
    ...(schema.type === "array" ? { style: "form", explode: true } : {}),
  }));
}
