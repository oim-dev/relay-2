import { useEffect } from "react";
import useSWR from "swr";
import type { SWRResponse } from "swr";
import { subscribeWorkspace } from "infra/workspace-events";
import { isEmptyArray } from "shared/value-predicates";
import { getProductTargetPreviews } from "../adapters/product-target-previews.adapter";
import type { ProductTargetPreview } from "../types/product-target-preview.type";

/**
 * Разделяет кеш названий видимых целей и обновляет его при изменениях продукта.
 */
export const useProductTargetPreviews = (
  projectId: string,
  targetIds: string[],
): SWRResponse<Map<string, ProductTargetPreview>, Error> => {
  const uniqueIds = [...new Set(targetIds)].sort();
  const query = useSWR<Map<string, ProductTargetPreview>, Error>(
    isEmptyArray(uniqueIds) ? null : ["product-target-previews", projectId, uniqueIds],
    () => getProductTargetPreviews(projectId, uniqueIds),
  );
  const { mutate } = query;
  useEffect(
    () =>
      subscribeWorkspace(projectId, (signal) => {
        if (signal.state === "connected") void mutate().catch(() => undefined);
      }),
    [projectId, mutate],
  );
  return query;
};
