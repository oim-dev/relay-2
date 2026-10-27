import { DOCUMENT_TARGET_KINDS } from "@relay/contracts";
import type { HttpEntityQuery } from "@relay/contracts";
import { readEntity, readPage, pageGeneration } from "domains/relay-data";
import { ApiError, getStorageFailureMessage, relayClient } from "infra/tasks-api";
import { toEntitySummary } from "../mappers/entity-summary";
import { getEntityPresentation } from "../helpers/get-entity-presentation";
import type { EntitiesQuery, EntitiesPage, EntitySummary } from "../types/entity-summary.type";
import type { EntityContent } from "../types/entity-content.type";

/**
 * Ожидаемый отказ доступа; причина HTTP сохраняется.
 */
export class EntityAccessError extends Error {}

/**
 * Отделяет недоступность источника от программных дефектов.
 */
function throwEntityFailure(error: unknown): never {
  if (error instanceof ApiError || error instanceof TypeError) {
    throw new EntityAccessError(getStorageFailureMessage(error) ?? error.message, { cause: error });
  }
  throw error;
}

/**
 * Читает окно одного вида. Общий селектор обходит виды с одним generation,
 * загружая только запрошенное окно каждого вида, а не все тела проекта.
 * Порядок общего каталога — виды DOCUMENT_TARGET_KINDS, затем порядок Core.
 */
export async function getEntities(projectId: string, query: EntitiesQuery): Promise<EntitiesPage> {
  try {
    const { kind, version, refs, ...filters } = query;
    const generation = pageGeneration(version);
    if (refs !== undefined) {
      const items: EntitySummary[] = [];
      let expected = generation;
      for (let offset = 0; offset < refs.length; offset += 200) {
        const result = (
          await relayClient.read(projectId, "getMany", {
            query: { ref: refs.slice(offset, offset + 200), summary: true },
          })
        ).data;
        if (result.view !== "summary") throw new Error("Ожидались краткие карточки прикреплений.");
        if (expected !== undefined && result.generation !== expected)
          throw new EntityAccessError("Проект изменился во время чтения. Обновите прикрепления.");
        expected = result.generation;
        for (const entry of result.items) {
          if (!entry.ok) throw new EntityAccessError(entry.error.message);
          const entity = entry.entity;
          items.push({
            ref: { kind: entity.kind, id: entity.id },
            title: entity.title,
            key: entity.key,
            revision: entity.revision,
            summary: "",
            ...(entity.state === undefined ? {} : { status: entity.state }),
            active: entity.active ?? true,
          });
        }
      }
      return { items, total: items.length, nextOffset: null, version: String(expected ?? 0) };
    }
    if (kind !== undefined) {
      const input: HttpEntityQuery = {
        ...filters,
        kind,
        ...(generation === undefined ? {} : { generation }),
      };
      const page = await readPage(projectId, input);
      return { ...page, items: page.items.map(toEntitySummary), version: String(page.generation) };
    }
    const offset = typeof query.offset === "number" ? query.offset : 0;
    const limit = typeof query.limit === "number" ? query.limit : 40;
    let expected = generation;
    let total = 0;
    const items: EntitySummary[] = [];
    for (const entryKind of DOCUMENT_TARGET_KINDS) {
      const page = await readPage(projectId, {
        kind: entryKind,
        ...(query.q ? { q: query.q } : {}),
        offset: 0,
        limit: 1,
        ...(expected === undefined ? {} : { generation: expected }),
      });
      expected = page.generation;
      const localOffset = Math.max(0, offset - total);
      if (localOffset < page.total && items.length < limit) {
        const window =
          localOffset === 0 && limit - items.length === 1
            ? page
            : await readPage(projectId, {
                kind: entryKind,
                ...(query.q ? { q: query.q } : {}),
                offset: localOffset,
                limit: limit - items.length,
                generation: expected,
              });
        items.push(...window.items.map(toEntitySummary));
      }
      total += page.total;
    }
    return {
      items,
      total,
      nextOffset: offset + items.length < total ? offset + items.length : null,
      version: String(expected),
    };
  } catch (error) {
    return throwEntityFailure(error);
  }
}

/**
 * Разрешает адрес через Core; не подменяет несуществующий адрес пустой карточкой.
 */
export async function getEntitySummary(projectId: string, ref: string): Promise<EntitySummary> {
  try {
    return toEntitySummary(await readEntity(projectId, ref));
  } catch (error) {
    return throwEntityFailure(error);
  }
}

/**
 * Читает текст только выбранной карточки.
 */
export async function getEntityContent(projectId: string, ref: string): Promise<EntityContent> {
  try {
    const entity = await readEntity(projectId, ref);
    let markdown = "";
    if (entity.kind === "document") markdown = entity.data.body;
    else if (entity.kind === "work-plan")
      markdown = [
        entity.data.goal,
        entity.data.rationale,
        entity.data.boundaries,
        entity.data.expectedResult,
        entity.data.result,
      ]
        .filter(Boolean)
        .join("\n\n");
    else if ("description" in entity.data && typeof entity.data.description === "string")
      markdown = entity.data.description;
    return {
      title: toEntitySummary(entity).title,
      markdown,
      ...(entity.kind === "board" ? { boardSlug: entity.data.slug } : {}),
    };
  } catch (error) {
    return throwEntityFailure(error);
  }
}

/**
 * Возвращает подпись вида, сохраняя неизвестное техническое имя.
 */
export const entityKindLabel = (kind: string): string => getEntityPresentation(kind).label;

/**
 * Прежние адреса этапов не являются самостоятельными сущностями текущего Core.
 */
export const isRelocatedEntityKind = (kind: string): boolean => kind === "plan-stage";
