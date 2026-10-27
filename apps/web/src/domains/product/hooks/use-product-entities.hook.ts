import { useEffect, useRef } from "react";
import useSWR, { useSWRConfig } from "swr";
import useSWRInfinite from "swr/infinite";
import { subscribeWorkspace } from "infra/workspace-events";
import { getProductEntities, getProductEntity } from "../adapters/product-entities.adapter";
import type {
  ProductEntitiesQuery,
  ProductEntities,
  ProductEntity,
} from "../types/product-entity.type";

/** Каталог целей; null не запускает запрос скрытого выбора. */
export const useProductEntities = (projectId: string, query: ProductEntitiesQuery | null) => {
  const result = useSWR<ProductEntities, Error>(
    query === null ? null : ["product-entities", projectId, query],
    () => getProductEntities(projectId, query!),
  );
  const { mutate } = result;
  useEffect(
    () =>
      subscribeWorkspace(projectId, (signal) => {
        if (signal.state === "connected") void mutate().catch(() => undefined);
      }),
    [projectId, mutate],
  );
  return result;
};

/** Адресный кеш подробностей; после разрешения URL потребитель использует стабильный ID. */
export const useProductEntity = (projectId: string, ref: string | null) => {
  const resolved = useRef(new Map<string, string>());
  const cache = useSWRConfig();
  const addressKey = `${projectId}:${ref}`;
  const stableRef = resolved.current.get(addressKey) ?? ref;
  const result = useSWR<ProductEntity, Error>(
    stableRef === null ? null : ["product-entity", projectId, stableRef],
    () => getProductEntity(projectId, stableRef!),
    {
      onSuccess: (entity) => {
        if (stableRef === entity.id) return;
        void cache.mutate(["product-entity", projectId, entity.id], entity, false);
        resolved.current.set(addressKey, entity.id);
      },
    },
  );
  const { mutate } = result;
  useEffect(
    () =>
      subscribeWorkspace(projectId, (signal) => {
        if (signal.state === "connected" && ref !== null) void mutate().catch(() => undefined);
      }),
    [projectId, ref, mutate],
  );
  return result;
};

/** Последовательные ограниченные страницы выбора без искусственного лимита всех результатов. */
export const useProductTargetSearch = (projectId: string, query: ProductEntitiesQuery | null) => {
  const result = useSWRInfinite<ProductEntities, Error>(
    (page, previous: ProductEntities | null) => {
      if (query === null || previous?.nextOffset === null) return null;
      return [
        "product-target-search",
        projectId,
        {
          ...query,
          limit: 20,
          offset: page === 0 ? 0 : (previous?.nextOffset ?? 0),
          ...(page === 0 ? {} : { version: previous?.version }),
        },
      ];
    },
    ([, project, input]: [string, string, ProductEntitiesQuery]) =>
      getProductEntities(project, input),
    { revalidateFirstPage: true },
  );
  const { mutate } = result;
  useEffect(
    () =>
      subscribeWorkspace(projectId, (signal) => {
        if (signal.state === "connected") void mutate().catch(() => undefined);
      }),
    [projectId, mutate],
  );
  const consistent =
    result.data?.every((page) => page.version === result.data?.[0]?.version) ?? true;
  return {
    ...result,
    error: consistent ? result.error : new Error("Каталог изменился. Обновите поиск с начала."),
    items: consistent ? (result.data?.flatMap((page) => page.items) ?? []) : [],
    hasMore:
      consistent &&
      result.data?.at(-1)?.nextOffset !== null &&
      result.data?.at(-1)?.nextOffset !== undefined,
  };
};
