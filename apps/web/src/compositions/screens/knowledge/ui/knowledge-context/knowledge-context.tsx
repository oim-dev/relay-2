import type { ReactElement } from "react";
import { Alert, Anchor, Button, Card, Stack, Text, Title } from "@mantine/core";
import { Link } from "react-router-dom";
import { useEntityPages, useProject, entityHref, entityName, errorMessage } from "domains/project";
import { EntityLink } from "domains/knowledge";
import type { KnowledgeContextProps } from "./types/knowledge-context-props.type";
import { messages } from "../../config/knowledge-screen.messages";

/**
 * Показывает реальные родительские и обратные связи карточки.
 *
 * Используется для:
 *  - переходов к сценариям, реализациям и документам выбранного знания
 */
export const KnowledgeContext = ({ entity }: KnowledgeContextProps): ReactElement => {
  const { projectId } = useProject();
  const documents = useEntityPages("document", { target: entity.id });
  let kind: "feature" | "scenario" | "implementation" = "implementation";
  if (entity.kind === "product") {
    kind = "feature";
  }
  if (entity.kind === "feature") {
    kind = "scenario";
  }
  const filters: Record<string, string> = {};
  if (entity.kind === "feature") {
    filters.feature = entity.id;
  }
  if (entity.kind === "application") {
    filters.application = entity.id;
  }
  if (entity.kind === "scenario" || entity.kind === "implementation") {
    filters.target = entity.kind === "implementation" ? entity.data.targetId : entity.id;
  }
  const related = useEntityPages(kind, filters);
  const hasRequirement = entity.kind === "feature" || entity.kind === "scenario";
  let heading = messages.implementations;
  if (entity.kind === "feature") {
    heading = messages.children;
  }
  if (entity.kind === "product") {
    heading = messages.features;
  }
  const hasDocumentError = documents.error !== undefined && documents.error !== null;
  const hasRelatedError = related.error !== undefined && related.error !== null;
  return (
    <Stack>
      {entity.kind === "scenario" && (
        <Card withBorder>
          <Text size="sm" c="dimmed">
            {messages.feature}
          </Text>
          <EntityLink id={entity.data.featureId} />
        </Card>
      )}
      {entity.kind === "implementation" && (
        <Card withBorder>
          <Text size="sm" c="dimmed">
            {messages.application}
          </Text>
          <EntityLink id={entity.data.applicationId} />
          <Text size="sm" c="dimmed" mt="sm">
            {messages.target}
          </Text>
          <EntityLink id={entity.data.targetId} />
        </Card>
      )}
      <Stack>
        <Title order={2} size="h4">
          {heading}
        </Title>
        {hasRelatedError && (
          <Alert color="orange">
            {errorMessage(related.error)}
            <Button variant="subtle" onClick={related.reload}>
              {messages.retry}
            </Button>
          </Alert>
        )}
        {related.items.map((item) => (
          <Anchor key={item.id} component={Link} to={entityHref(projectId, item.id)}>
            {item.key} · {entityName(item)}
          </Anchor>
        ))}
        {related.hasMore && (
          <Button variant="default" onClick={related.loadMore} loading={related.loading}>
            {messages.more}
          </Button>
        )}
      </Stack>
      {hasRequirement && (
        <Anchor
          component={Link}
          to={`/projects/${projectId}/knowledge/implementation?target=${encodeURIComponent(entity.id)}`}
        >
          {messages.allImplementations}
        </Anchor>
      )}
      <Title order={2} size="h4">
        {messages.documents}
      </Title>
      {hasDocumentError && (
        <Alert color="orange">
          {errorMessage(documents.error)}
          <Button variant="subtle" onClick={documents.reload}>
            {messages.retry}
          </Button>
        </Alert>
      )}
      {documents.items.map((item) => (
        <Anchor key={item.id} component={Link} to={entityHref(projectId, item.id)}>
          {item.key} · {entityName(item)}
        </Anchor>
      ))}
      {documents.hasMore && (
        <Button variant="default" onClick={documents.loadMore} loading={documents.loading}>
          {messages.more}
        </Button>
      )}
    </Stack>
  );
};
