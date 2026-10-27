import { useEffect } from "react";
import useSWR from "swr";
import type { SWRResponse } from "swr";
import { subscribeWorkspace } from "infra/workspace-events";
import { getProduct } from "../adapters/product.adapter";
import type { ProductState } from "../types/product.type";

/**
 * Владеет серверным кешем продукта и сверкой после SSE/reconnect.
 */
export const useProduct = (projectId: string): SWRResponse<ProductState, Error> => {
  const query = useSWR<ProductState, Error>(["product", projectId], () => getProduct(projectId), {
    refreshInterval: 30_000,
  });
  const { mutate } = query;
  useEffect(
    () =>
      subscribeWorkspace(projectId, (signal) => {
        if (signal.state === "connected") void mutate();
      }),
    [projectId, mutate],
  );
  return query;
};
