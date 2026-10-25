import type { ReactElement } from "react";
import { Anchor, Badge, Button, Card, Group, Stack, Text } from "@mantine/core";
import { Link } from "react-router-dom";
import { documentKindLabel, documentStatusLabel, relationLabel } from "domains/documents";
import type { DocumentMaterialProps } from "./types/document-material-props.type";
import { messages } from "../../config/entity-documents.messages";

/**
 * Показывает материал и отдельные отношения к текущей рабочей карточке.
 *
 * Используется для:
 *  - перехода к содержанию документа и снятия одной связи без удаления материала
 */
export const DocumentMaterial = (props: DocumentMaterialProps): ReactElement => {
  const data = props.document.data;
  const relations = data.relations.filter(
    (relation) =>
      relation.target.id === props.target.id && relation.target.kind === props.target.kind,
  );
  const hasSummary = data.summary !== "";
  return (
    <Card component="li" withBorder radius="md">
      <Stack gap="xs">
        <Anchor component={Link} to={props.href} fw={600}>
          {data.name}
        </Anchor>
        <Group gap="xs">
          <Text size="xs" c="dimmed">
            {props.document.key}
          </Text>
          <Badge variant="light">{documentKindLabel(data.documentKind)}</Badge>
          <Badge variant="outline">{documentStatusLabel(data.documentStatus)}</Badge>
        </Group>
        {hasSummary && (
          <Text size="sm" c="dimmed">
            {data.summary}
          </Text>
        )}
        {relations.map((relation) => (
          <Group key={relation.type} justify="space-between" align="start">
            <div>
              <Text size="sm">{relationLabel(relation.type)}</Text>
              <Text size="xs" c="dimmed">
                {relation.description}
              </Text>
            </div>
            <Button
              size="compact-xs"
              variant="subtle"
              color="red"
              disabled={props.disabled}
              onClick={() => props.onUnlink(props.document.id, relation.type)}
            >
              {messages.unlink}
            </Button>
          </Group>
        ))}
      </Stack>
    </Card>
  );
};
