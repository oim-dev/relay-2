import type { NamedCommand, ProjectEntity } from "@relay/contracts";
import { ENTITY_PAGE_SIZE } from "@relay/contracts";
import { relayClient } from "infra/tasks-api";
import { readEntity, readPage, writeCommands, pageGeneration } from "domains/relay-data";
import { toProductEntity, toProductSummary } from "../mappers/product-record";
import type {
  ProductEntitiesQuery,
  ImplementationChange,
  ProductEntities,
  ProductEntity,
} from "../types/product-entity.type";

/**
 * Читает адресный набор и отклоняет весь результат при ошибке любой ссылки.
 * Поколение проверяется также между порциями и при чтении названий родителей.
 */
async function readReferences(
  project: string,
  refs: string[],
  generation?: number,
): Promise<{ entities: ProjectEntity[]; generation: number }> {
  const entities: ProjectEntity[] = [];
  let expected = generation;
  for (let offset = 0; offset < refs.length; offset += 200) {
    const result = (
      await relayClient.read(project, "getMany", {
        query: { ref: refs.slice(offset, offset + 200) },
      })
    ).data;
    if (result.view !== "full") throw new Error("Ожидались полные продуктовые записи.");
    if (expected !== undefined && result.generation !== expected)
      throw new Error("Продукт изменился во время чтения. Обновите список с начала.");
    expected = result.generation;
    for (const item of result.items) {
      if (!item.ok) throw new Error(item.error.message);
      entities.push(item.entity);
    }
  }
  if (expected === undefined) throw new Error("Не задан адрес продуктовой записи.");
  return { entities, generation: expected };
}

/**
 * Каталог старого выбора. Один вид использует окно Core; объединённый выбор
 * и фильтр targetKind требуют полного соответствующего набора до окна.
 * Все части и родители проверяют одно generation; готовность не рассчитывается.
 */
export async function getProductEntities(
  project: string,
  query: ProductEntitiesQuery,
): Promise<ProductEntities> {
  let generation = pageGeneration(query.version);
  let entities: ProjectEntity[] = [];
  let total = 0;
  let nextOffset: number | null = null;
  if (query.refs) {
    if (query.refs.length === 0)
      return { items: [], total: 0, nextOffset: null, version: query.version ?? "0" };
    const read = await readReferences(project, query.refs, generation);
    entities = read.entities;
    generation = read.generation;
    total = entities.length;
  } else {
    const kinds = query.kind
      ? [query.kind === "passport" ? ("product" as const) : query.kind]
      : (["feature", "scenario", "implementation"] as const);
    const complete = kinds.length > 1 || query.implementationTarget !== undefined;
    for (const kind of kinds) {
      let offset: number | null = complete ? 0 : (query.offset ?? 0);
      do {
        const page = await readPage(project, {
          kind,
          offset,
          limit: complete ? ENTITY_PAGE_SIZE.max : (query.limit ?? 40),
          ...(generation === undefined ? {} : { generation }),
          ...(query.q ? { q: query.q } : {}),
          ...(kind === "implementation" && query.application
            ? { application: query.application }
            : {}),
          ...(kind === "implementation" && query.active ? { active: query.active === "true" } : {}),
        });
        generation = page.generation;
        entities.push(...page.items);
        total = page.total;
        nextOffset = page.nextOffset;
        offset = complete ? page.nextOffset : null;
      } while (offset !== null);
    }
    if (complete) {
      if (query.implementationTarget)
        entities = entities.filter(
          (entry) =>
            entry.kind === "implementation" && entry.data.targetKind === query.implementationTarget,
        );
      total = entities.length;
      const offset = query.offset ?? 0;
      entities = entities.slice(offset, offset + (query.limit ?? 40));
      nextOffset = offset + entities.length < total ? offset + entities.length : null;
    }
  }
  const related = new Map(entities.map((entry) => [entry.id, entry]));
  const parentIds = [
    ...new Set(
      entities.flatMap((entry) => {
        if (entry.kind === "implementation")
          return [entry.data.applicationId, entry.data.featureId, entry.data.targetId];
        if (entry.kind === "scenario") return [entry.data.featureId];
        return [];
      }),
    ),
  ].filter((id) => !related.has(id));
  if (parentIds.length > 0) {
    const parents = await readReferences(project, parentIds, generation);
    for (const parent of parents.entities) related.set(parent.id, parent);
  }
  if (generation === undefined) throw new Error("Не получено поколение каталога.");
  return {
    items: entities.map((entry) => toProductSummary(entry, related)),
    total,
    nextOffset,
    version: String(generation),
  };
}

/**
 * Адресно читает одну продуктовую запись с её собственной исходной ревизией.
 */
export async function getProductEntity(project: string, ref: string): Promise<ProductEntity> {
  return toProductEntity(await readEntity(project, ref));
}

/**
 * Явно меняет статус и содержание реализации; active не входит в эту операцию.
 * Переименование при необходимости выполняется тем же атомарным пакетом.
 */
export async function updateProductImplementation(
  project: string,
  change: ImplementationChange,
): Promise<void> {
  const input = {
    ...(change.title === undefined ? {} : { title: change.title }),
    ...(change.description === undefined ? {} : { description: change.description }),
    ...(change.status === undefined ? {} : { status: change.status }),
  };
  const commands: NamedCommand[] = [];
  if (Object.keys(input).length > 0)
    commands.push({
      op: "implementation.update",
      as: "content",
      ref: change.ref,
      ifRevision: change.ifRevision,
      input,
    });
  if (change.key !== undefined)
    commands.push({
      op: "implementation.rename",
      ref: change.ref,
      ifRevision: commands.length ? { $revision: "content" } : change.ifRevision,
      input: { key: change.key },
    });
  await writeCommands(project, commands, change.requestId);
}
