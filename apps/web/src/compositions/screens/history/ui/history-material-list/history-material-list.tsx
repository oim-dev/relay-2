import type { ReactElement } from "react";
import { Alert, Badge, Button, Card, Group, Stack, Text, Title } from "@mantine/core";
import { errorMessage, useEntityPages } from "domains/project";
import { isEmptyArray } from "shared/value-predicates";
import type { HistoryMaterialListProps } from "./types/history-material-list-props.type";
import { historyMessages as m } from "../../history.messages";

/**
 * Показывает компактные карточки серверной страницы материалов без рендера Markdown-тел.
 * HTTP передаёт до 40 полных ProjectEntity за страницу; чтение полного набора внутри Core сохраняется.
 *
 * Используется для:
 *  - просмотра истории с generation-aware продолжением
 *  - выбора материала для отдельного адресного чтения
 */
export function HistoryMaterialList({ onOpen }: HistoryMaterialListProps): ReactElement {
  const page = useEntityPages("work-checkpoint", { sort: "updated" });
  const checkpoints = page.items.filter((entry) => entry.kind === "work-checkpoint");
  const isEmpty = !page.loading && page.error === undefined && isEmptyArray(checkpoints);
  const hasTotal = page.total !== undefined;
  const countLabel = page.total === undefined ? "" : m.pageCount(checkpoints.length, page.total);
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
      {checkpoints.map((checkpoint) => (
        <Card key={checkpoint.id} withBorder component="article">
          <Stack gap="xs">
            <Group justify="space-between">
              <Badge variant="light">{m.kinds[checkpoint.data.kind]}</Badge>
              <Text size="xs" c="dimmed">
                {checkpoint.data.actor} · {checkpoint.createdAt}
              </Text>
            </Group>
            <Title order={3} size="h4">
              {checkpoint.data.title}
            </Title>
            <Text lineClamp={2} size="sm">
              {checkpoint.data.summary}
            </Text>
            <Button variant="subtle" w="fit-content" onClick={() => onOpen(checkpoint.id)}>
              {m.openMaterial}
            </Button>
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
