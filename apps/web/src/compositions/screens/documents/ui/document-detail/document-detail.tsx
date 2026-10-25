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
import { errorMessage, useEntity, useProject, useRead } from "domains/project";
import { EntityLink } from "domains/knowledge";
import { documentKindLabel, documentStatusLabel, relationLabel } from "domains/documents";
import { MarkdownView } from "ui/markdown-view";
import { isEmptyArray } from "shared/value-predicates";
import { DocumentEditor } from "../document-editor/document-editor";
import { messages } from "../../config/documents.messages";

/**
 * Представляет читаемый Markdown документа, его публикацию, раздел и отношения.
 *
 * Используется для:
 *  - чтения материала и переходов к контексту
 *  - открытия редактора с исходными CAS и переносимой версией
 */
export const DocumentScreen = (): ReactElement => {
  const { ref } = useParams();
  const { projectId } = useProject();
  const query = useEntity(ref);
  const sections = useRead("documentSections", {});
  const [editing, setEditing] = useState(false);
  const entity = query.data?.entity;
  if (entity === undefined || query.data === undefined) {
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
  if (entity.kind !== "document") {
    return <Alert color="orange">{messages.unavailable}</Alert>;
  }
  const data = entity.data;
  const isDraft = data.documentStatus === "draft";
  const isArchived = data.documentStatus === "archived";
  const sectionName =
    sections.data?.items.find((section) => section.id === data.sectionId)?.name ??
    data.sectionId ??
    messages.noSection;
  const hasError = query.error !== undefined;
  const hasSectionsError = sections.error !== undefined;
  const hasNoRelations = isEmptyArray(data.relations);
  return (
    <Stack style={{ minWidth: 0, overflowWrap: "anywhere" }}>
      <Anchor component={Link} to={`/projects/${projectId}/documents`}>
        {messages.back}
      </Anchor>
      <Group justify="space-between" align="start">
        <div>
          <Title order={1}>{data.name}</Title>
          <Text c="dimmed">{data.summary}</Text>
        </div>
        <Button onClick={() => setEditing(true)}>{messages.edit}</Button>
      </Group>
      <Group gap="xs">
        <Badge variant="light">{documentKindLabel(data.documentKind)}</Badge>
        <Badge variant="outline">{documentStatusLabel(data.documentStatus)}</Badge>
        <Text size="sm" c="dimmed">
          {entity.key}
        </Text>
        {data.pinned && <Badge color="yellow">{messages.pinned}</Badge>}
      </Group>
      {hasError && (
        <Alert color="orange">
          {errorMessage(query.error)}
          <Button variant="subtle" onClick={() => void query.mutate()}>
            {messages.retry}
          </Button>
        </Alert>
      )}
      {isDraft && <Alert color="yellow">{messages.draftNotice}</Alert>}
      {isArchived && <Alert color="gray">{messages.archiveNotice}</Alert>}
      <Card component="article" withBorder radius="md" p={{ base: "md", md: "xl" }}>
        <MarkdownView text={data.body} headingStartLevel={2} focusableBlocks />
      </Card>
      <Group>
        <Text size="sm" c="dimmed">
          {messages.section}
        </Text>
        <Text size="sm">{sectionName}</Text>
      </Group>
      {hasSectionsError && (
        <Alert color="orange">
          {errorMessage(sections.error)}
          <Button variant="subtle" onClick={() => void sections.mutate()}>
            {messages.retry}
          </Button>
        </Alert>
      )}
      <Title order={2} size="h4">
        {messages.relations}
      </Title>
      {hasNoRelations && <Text c="dimmed">{messages.noRelations}</Text>}
      {data.relations.map((relation) => (
        <Card key={`${relation.target.id}:${relation.type}`} withBorder>
          <Text size="xs" c="dimmed">
            {relationLabel(relation.type)}
          </Text>
          <EntityLink id={relation.target.id} />
          <Text size="sm">{relation.description}</Text>
        </Card>
      ))}
      <Text size="xs" c="dimmed">
        {messages.revision} {entity.revision} · {entity.id}
      </Text>
      <Modal opened={editing} onClose={() => setEditing(false)} title={messages.edit} size="xl">
        {editing && (
          <DocumentEditor
            key={entity.id}
            source={query.data}
            sectionId={data.sectionId}
            onClose={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              void query.mutate();
            }}
          />
        )}
      </Modal>
    </Stack>
  );
};
