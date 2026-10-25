import useSWRInfinite from "swr/infinite";
import { useEffect, useState } from "react";
import type { EntityKind, HttpEntityPage } from "@relay/contracts";
import { relayClient } from "infra/relay-api";
import { useProject } from "../project-context";
import type { EntityPages } from "../types/project.types";
import { projectDataMessages } from "../project.messages";
import { subscribeProjectInvalidation } from "../operations/invalidation";

/**
 * Продолжает список только в исходном generation. Ошибка PAGE_CHANGED оставляет
 * прочитанное окно видимым и требует явного reload; страницы разных снимков не склеиваются.
 */
export function useEntityPages(
  kind: EntityKind,
  filters: Readonly<Record<string, string>> = {},
): EntityPages {
  const scope = useProject();
  const [epoch, setEpoch] = useState(0);
  const pages = useSWRInfinite<HttpEntityPage>(
    (index, previous: HttpEntityPage | null) => {
      if (previous?.nextOffset === null) {
        return null;
      }
      return [
        scope.serverKey,
        scope.projectId,
        "pages",
        kind,
        filters,
        epoch,
        index,
        previous?.nextOffset ?? 0,
        previous?.generation,
      ];
    },
    async (
      key: readonly [
        string,
        string,
        string,
        EntityKind,
        Readonly<Record<string, string>>,
        number,
        number,
        number,
        number | undefined,
      ],
    ) =>
      (
        await relayClient.entities(key[1], {
          sort: "key",
          ...key[4],
          kind: key[3],
          offset: key[7],
          limit: 40,
          ...(key[8] === undefined ? {} : { generation: key[8] }),
        })
      ).data,
    { revalidateFirstPage: false, revalidateAll: true, persistSize: false },
  );
  const { mutate } = pages;
  useEffect(
    () =>
      subscribeProjectInvalidation(scope, () => {
        void mutate();
      }),
    [scope, mutate],
  );
  const first = pages.data?.[0];
  const coherent = pages.data?.every((page) => page.generation === first?.generation) ?? true;
  const last = pages.data?.at(-1);
  return {
    items: coherent ? (pages.data?.flatMap((page) => page.items) ?? []) : (first?.items ?? []),
    total: first?.total,
    loading: pages.isLoading || pages.isValidating,
    error: pages.error ?? (coherent ? undefined : new Error(projectDataMessages.pageChanged)),
    hasMore: coherent && last !== undefined && last.nextOffset !== null,
    loadMore: () => {
      if (!pages.isValidating && !pages.error) {
        void pages.setSize(pages.size + 1);
      }
    },
    reload: () => {
      setEpoch((value) => value + 1);
    },
  };
}
