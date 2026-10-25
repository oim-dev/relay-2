import { useState, type ReactElement } from "react";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  Modal,
  Skeleton,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { Link, useParams } from "react-router-dom";
import { entityName, errorMessage, useEntity, useProject } from "domains/project";
import {
  implementationLabel,
  implementationActivityLabel,
  isCatalogEntity,
} from "domains/knowledge";
import { MarkdownView } from "ui/markdown-view";
import { KnowledgeEditor } from "../knowledge-editor/knowledge-editor";
import { ParticipationEditor } from "../participation-editor/participation-editor";
import { KnowledgeContext } from "../knowledge-context/knowledge-context";
import { messages } from "../../config/knowledge-screen.messages";

/**
 * Открывает знание по постоянному адресу и координирует независимые редакторы.
 *
 * Используется для:
 *  - чтения Markdown и связей знания
 *  - изменения содержания и участия реализации через текущие команды Core
 */
export const KnowledgeEntityScreen = (): ReactElement => {
  const { ref } = useParams();
  const { projectId } = useProject();
  const query = useEntity(ref);
  const [editing, setEditing] = useState(false);
  const [participating, setParticipating] = useState(false);
  const entity = query.data?.entity;
  const ownerId = entity?.kind === "implementation" ? entity.data.applicationId : undefined;
  const owner = useEntity(participating ? ownerId : undefined);
  if (query.data === undefined || entity === undefined) {
    if (query.error !== undefined) {
      return (
        <Alert color="orange" title={messages.unavailable}>
          {errorMessage(query.error)}
          <Button onClick={() => void query.mutate()}>{messages.retry}</Button>
        </Alert>
      );
    }
    return <Skeleton height={240} />;
  }
  if (!isCatalogEntity(entity)) {
    return <Alert color="orange">{messages.invalidKind}</Alert>;
  }
  const isImplementation = entity.kind === "implementation";
  const canParticipate = isImplementation && owner.data?.entity.kind === "application";
  const description = entity.data.description ?? "";
  const summary = "summary" in entity.data ? entity.data.summary : undefined;
  const hasError = query.error !== undefined;
  const ownerHasError = owner.error !== undefined;
  return (
    <Stack style={{ minWidth: 0, overflowWrap: "anywhere" }}>
      <Anchor component={Link} to={`/projects/${projectId}/knowledge/${entity.kind}`}>
        {messages.back}
      </Anchor>
      <Group justify="space-between">
        <div>
          <Text size="xs" c="dimmed">
            {entity.key}
          </Text>
          <Title order={1}>{entityName(entity)}</Title>
          <Text c="dimmed">{summary}</Text>
        </div>
        <Group>
          <Button onClick={() => setEditing(true)}>{messages.edit}</Button>
          {isImplementation && (
            <Button variant="default" onClick={() => setParticipating(true)}>
              {messages.participation}
            </Button>
          )}
        </Group>
      </Group>
      {hasError && (
        <Alert color="orange">
          {errorMessage(query.error)}
          <Button variant="subtle" onClick={() => void query.mutate()}>
            {messages.retry}
          </Button>
        </Alert>
      )}
      {entity.kind === "implementation" && (
        <Group>
          <Badge>{implementationLabel(entity.data.status)}</Badge>
          <Badge variant="outline">{implementationActivityLabel(entity.data.active)}</Badge>
        </Group>
      )}
      <Card withBorder radius="md">
        <MarkdownView
          text={description}
          emptyText={messages.descriptionField}
          headingStartLevel={2}
        />
      </Card>
      <KnowledgeContext entity={entity} />
      <Text size="xs" c="dimmed">
        {messages.revision} {entity.revision} · {entity.id}
      </Text>
      <Modal opened={editing} onClose={() => setEditing(false)} title={messages.edit} size="lg">
        {editing && (
          <KnowledgeEditor
            key={entity.id}
            kind={entity.kind}
            source={query.data}
            owner={null}
            onClose={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              void query.mutate();
            }}
          />
        )}
      </Modal>
      <Modal
        opened={participating}
        onClose={() => setParticipating(false)}
        title={messages.participation}
      >
        {ownerHasError && (
          <Alert color="orange">
            {errorMessage(owner.error)}
            <Button onClick={() => void owner.mutate()}>{messages.retry}</Button>
          </Alert>
        )}
        {canParticipate && owner.data !== undefined && (
          <ParticipationEditor
            key={entity.id}
            implementationId={entity.id}
            owner={owner.data}
            onClose={() => setParticipating(false)}
            onSaved={() => {
              setParticipating(false);
              void query.mutate();
              void owner.mutate();
            }}
          />
        )}
      </Modal>
    </Stack>
  );
};
