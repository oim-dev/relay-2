import { Alert, Badge, Button, Loader, Paper, Stack, Text, Title } from "@mantine/core";
import type { ReactElement } from "react";
import { useRead } from "domains/project";
import { EntityReference } from "domains/tasks";
import { isEmptyArray } from "shared/value-predicates";
import { taskScreenMessages as messages } from "../../config/task-screen.messages";
import type { TaskSectionProps } from "../../types/task-editor.types";

/**
 * Показывает фактическую готовность из серверного TaskProgress.
 *
 * Используется для:
 *  - чтения completed/canComplete и перехода к прямым блокерам без собственного графа
 */
export const TaskProgress = ({ snapshot }: TaskSectionProps): ReactElement => {
  const query = useRead("taskProgress", { ref: snapshot.task.id });
  const progress = query.data;
  if (query.error !== undefined) {
    return (
      <Alert color="orange" title={messages.projectionError}>
        <Button variant="subtle" onClick={() => void query.mutate()}>
          {messages.reload}
        </Button>
      </Alert>
    );
  }
  if (progress === undefined) {
    return <Loader size="sm" aria-label={messages.progress} />;
  }
  const completed = progress.completed ? messages.completed : messages.incomplete;
  const readiness = progress.canComplete ? messages.canComplete : messages.cannotComplete;
  const color = progress.completed ? "teal" : "gray";
  const isEmpty = isEmptyArray(progress.blockers);
  return (
    <Paper withBorder p="md">
      <Stack gap="sm">
        <Title order={2} size="h4">
          {messages.progress}
        </Title>
        <Badge color={color} variant="light" style={{ whiteSpace: "normal", height: "auto" }}>
          {completed}
        </Badge>
        <Text size="sm">{readiness}</Text>
        <Text size="xs" c="dimmed">
          {messages.criteriaHint}
        </Text>
        <Text fw={600} size="sm">
          {messages.blockers}
        </Text>
        {isEmpty && (
          <Text size="sm" c="dimmed">
            {messages.noBlockers}
          </Text>
        )}
        {progress.blockers.map((id) => (
          <EntityReference key={id} id={id} />
        ))}
      </Stack>
    </Paper>
  );
};
