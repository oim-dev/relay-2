import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import type { ReactElement } from "react";
import { Link } from "react-router-dom";
import { useEntityPages, useProject } from "domains/project";
import { taskColumnLabels, taskMessages } from "domains/tasks";
import { boardMessages } from "../../config/board.messages";
import type { BoardColumnProps } from "./types/board-column-props.type";
import styles from "./styles/board-column.module.css";

/**
 * Показывает страницу задач колонки без локальных пересчётов готовности.
 *
 * Используется для:
 *  - чтения всех колонок независимо от распределения задач в общей странице
 */
export const BoardColumn = ({ boardId, column, filters }: BoardColumnProps): ReactElement => {
  const query = useEntityPages("task", { ...filters, board: boardId, column });
  const { projectId } = useProject();
  const taskItems = query.items.filter((entity) => entity.kind === "task");
  const isEmpty = query.total === 0;
  return (
    <section className={styles.root} aria-label={taskColumnLabels[column]}>
      <Group justify="space-between">
        <Title order={2} size="sm">
          {taskColumnLabels[column]}
        </Title>
        <Badge color="gray" variant="light">
          {query.total ?? "…"}
        </Badge>
      </Group>
      {query.error !== undefined && (
        <Alert color="red" title={boardMessages.tasksError}>
          <Button variant="subtle" onClick={query.reload}>
            {boardMessages.reload}
          </Button>
        </Alert>
      )}
      {isEmpty && (
        <Text size="sm" c="dimmed">
          {boardMessages.empty}
        </Text>
      )}
      <Stack gap="sm">
        {taskItems.map((task) => (
          <Card key={task.id} withBorder padding="sm" className={styles.card}>
            <Text size="xs" c="dimmed">
              {task.key}
            </Text>
            <Anchor
              component={Link}
              to={`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}`}
              fw={600}
            >
              {task.data.title || taskMessages.unnamed}
            </Anchor>
            <Text size="xs" c="dimmed" lineClamp={3}>
              {task.data.description}
            </Text>
          </Card>
        ))}
      </Stack>
      {query.loading && <Loader size="sm" aria-label={boardMessages.loading} />}
      {query.hasMore && (
        <Button variant="subtle" loading={query.loading} onClick={query.loadMore}>
          {boardMessages.more}
        </Button>
      )}
    </section>
  );
};
