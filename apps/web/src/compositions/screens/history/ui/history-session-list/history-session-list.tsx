import type { ReactElement } from "react";
import { Link } from "react-router-dom";
import { Alert, Badge, Button, Card, Group, Stack, Text, Title } from "@mantine/core";
import { errorMessage, useEntityPages, useProject } from "domains/project";
import { isEmptyArray } from "shared/value-predicates";
import type { HistorySessionListProps } from "./types/history-session-list-props.type";
import { historyMessages as m } from "../../history.messages";

/**
 * Показывает серверные страницы сессий с продолжением в исходном generation.
 *
 * Используется для:
 *  - поиска и отбора сессий по текущим правилам Core
 *  - явного обновления списка при несовместимых поколениях
 */
export function HistorySessionList({ query, status }: HistorySessionListProps): ReactElement {
  const { projectId } = useProject();
  const page = useEntityPages("work-session", {
    sort: "updated",
    ...(status === undefined ? {} : { status }),
    ...(query.trim() === "" ? {} : { q: query }),
  });
  const sessions = page.items.filter((entry) => entry.kind === "work-session");
  const isEmpty = !page.loading && page.error === undefined && isEmptyArray(sessions);
  const hasTotal = page.total !== undefined;
  const countLabel = page.total === undefined ? "" : m.pageCount(sessions.length, page.total);
  return (
    <Stack>
      {page.error !== undefined && (
        <Alert color="red" title={m.readFailure}>
          {errorMessage(page.error)}
          <Button variant="subtle" onClick={page.reload}>
            {m.refresh}
          </Button>
        </Alert>
      )}
      {page.loading && <Text role="status">{m.loading}</Text>}
      {isEmpty && <Text c="dimmed">{m.empty}</Text>}
      {hasTotal && (
        <Text size="sm" c="dimmed" role="status">
          {countLabel}
        </Text>
      )}
      {sessions.map((session) => (
        <Card key={session.id} withBorder component="article">
          <Stack gap="xs">
            <Group justify="space-between">
              <Title order={2} size="h4">
                <Link to={`/projects/${projectId}/history/sessions/${session.id}`}>
                  {session.data.title}
                </Link>
              </Title>
              <Badge variant="light">{m.statuses[session.data.status]}</Badge>
            </Group>
            <Text lineClamp={2} size="sm">
              {session.data.description}
            </Text>
            <Text size="xs" c="dimmed">
              {session.updatedAt} · {session.updatedBy}
            </Text>
          </Stack>
        </Card>
      ))}
      {page.hasMore && (
        <Button
          variant="default"
          loading={page.loading}
          disabled={page.error !== undefined}
          onClick={page.loadMore}
        >
          {m.more}
        </Button>
      )}
    </Stack>
  );
}
