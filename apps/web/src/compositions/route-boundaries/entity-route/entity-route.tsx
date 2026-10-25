import type { ReactElement } from "react";
import { Navigate, useParams } from "react-router-dom";
import { Button } from "@mantine/core";
import { errorMessage, useEntity, useProject } from "domains/project";
import { KnowledgeEntityScreen } from "compositions/screens/knowledge";
import { DocumentScreen } from "compositions/screens/documents";
import { StatePanel } from "ui/state-panel";
import { entityRouteMessages as m } from "./entity-route.messages";

/**
 * Разрешает постоянный адрес в предметный экран без переноса правил в маршрутизатор.
 */
export function EntityRoute(): ReactElement {
  const { ref } = useParams();
  const { projectId } = useProject();
  const record = useEntity(ref);
  if (!record.data) {
    return (
      <StatePanel
        title={m.title}
        isLoading={record.isLoading}
        description={record.error ? errorMessage(record.error) : m.loading}
        action={<Button onClick={() => void record.mutate()}>{m.retry}</Button>}
      />
    );
  }
  const { entity } = record.data;
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const id = encodeURIComponent(entity.id);
  switch (entity.kind) {
    case "document":
      return <DocumentScreen />;
    case "task":
      return <Navigate to={`${base}/tasks/${id}`} replace />;
    case "work-plan":
      return <Navigate to={`${base}/plans/${id}`} replace />;
    case "release":
      return <Navigate to={`${base}/releases/${id}`} replace />;
    case "work-session":
      return <Navigate to={`${base}/history/sessions/${id}`} replace />;
    case "work-checkpoint":
      return (
        <Navigate
          to={`${base}/history/sessions/${encodeURIComponent(entity.data.sessionId)}?checkpoint=${id}`}
          replace
        />
      );
    case "board":
      return <Navigate to={`${base}/board?board=${id}`} replace />;
    case "project":
      return <Navigate to={base} replace />;
    default:
      return <KnowledgeEntityScreen />;
  }
}
