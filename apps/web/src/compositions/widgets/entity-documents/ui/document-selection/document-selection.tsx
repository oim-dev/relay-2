import type { ReactElement } from "react";
import { Alert, Button, Card, Stack, Text } from "@mantine/core";
import { EntityPicker } from "domains/knowledge";
import { isDocumentSnapshot } from "domains/documents";
import { errorMessage, useEntity } from "domains/project";
import type { DocumentSelectionProps } from "./types/document-selection-props.type";
import { messages } from "../../config/entity-documents.messages";

/**
 * Выбирает существующий материал и читает его исходную версию до изменения связи.
 *
 * Используется для:
 *  - начала прикрепления и снятия отношения без свежего guard при submit
 */
export const DocumentSelection = (props: DocumentSelectionProps): ReactElement => {
  const query = useEntity(props.selection.documentId ?? undefined);
  const source =
    query.data !== undefined && isDocumentSnapshot(query.data) ? query.data : undefined;
  const canChoose = props.selection.action === "link";
  const hasError = query.error !== undefined;
  const canPrepare = source !== undefined && !hasError && !query.isLoading;
  return (
    <Stack>
      {canChoose && (
        <EntityPicker
          kind="document"
          label={messages.choose}
          value={props.selection.documentId}
          onChange={props.onSelect}
        />
      )}
      {hasError && (
        <Alert color="orange" title={messages.unavailable}>
          {errorMessage(query.error)}
          <Button variant="subtle" onClick={() => void query.mutate()}>
            {messages.retry}
          </Button>
        </Alert>
      )}
      {source !== undefined && (
        <Card withBorder>
          <Text fw={600}>{source.entity.data.name}</Text>
          <Text size="sm" c="dimmed">
            {source.entity.data.summary}
          </Text>
          <Text size="xs" c="dimmed">
            {source.entity.key} · {messages.revision} {source.entity.revision}
          </Text>
        </Card>
      )}
      <Button
        disabled={!canPrepare}
        loading={query.isLoading}
        onClick={() => {
          if (source !== undefined) {
            props.onPrepare(source);
          }
        }}
      >
        {messages.prepare}
      </Button>
      <Button variant="subtle" onClick={props.onDiscard}>
        {messages.discard}
      </Button>
    </Stack>
  );
};
