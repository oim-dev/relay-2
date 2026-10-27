import type { ReactElement } from "react";
import { Navigate, useLocation, useParams, useSearchParams } from "react-router-dom";
import useSWR from "swr";
import { Button } from "@mantine/core";
import { useProjectId, useProjectBasePath } from "domains/project";
import { readEntity } from "domains/relay-data";
import { StatePanel } from "ui/state-panel";
import { entityRouteMessages as m } from "./entity-route.messages";
import { entityRouteTarget, entityRouteLocation } from "./entity-route-path";

const catalogs: Readonly<Record<string, string>> = {
  product: "product/passport",
  feature: "product/features",
  scenario: "product/features",
  application: "product/applications",
  implementation: "product/applications",
};

/**
 * Открывает постоянный адрес Relay 2 в исходной иерархии экранов легаси.
 * Разрешение адреса принадлежит SDK/Core; маршрут сохраняет query/hash и state возврата.
 */
export function EntityRoute(): ReactElement {
  const { ref, kind } = useParams();
  const [params] = useSearchParams();
  const location = useLocation();
  const projectId = useProjectId();
  const base = useProjectBasePath();
  const reference = ref ?? (location.pathname.endsWith("/board") ? params.get("board") : null);
  const record = useSWR(reference !== null ? ["route/entity", projectId, reference] : null, () =>
    readEntity(projectId, reference ?? ""),
  );
  let target: string | undefined;
  if (kind !== undefined) target = catalogs[kind];
  else if (location.pathname.endsWith("/history")) target = "work-history";
  else if (reference === null && location.pathname.endsWith("/board")) target = "boards/product";
  const entity = record.data;
  if (entity !== undefined) target = entityRouteTarget(entity);
  if (target !== undefined) {
    return (
      <Navigate
        to={entityRouteLocation(base, target, location.search, location.hash)}
        replace
        state={location.state}
      />
    );
  }
  if (kind !== undefined) {
    return (
      <StatePanel title="Раздел не найден" description="Выберите раздел в навигации проекта." />
    );
  }
  return (
    <StatePanel
      title={m.title}
      isLoading={record.isLoading}
      description={record.error instanceof Error ? record.error.message : m.loading}
      action={<Button onClick={() => void record.mutate()}>{m.retry}</Button>}
    />
  );
}
