import type { ReactElement } from "react";
import { Link } from "react-router-dom";
import { Alert, Anchor, Button, Card, List, Progress, Stack, Text } from "@mantine/core";
import { errorMessage, entityHref, useProject } from "domains/project";
import type { PlanningProgressProps } from "./types/planning-progress-props.type";
import { planningMessages as m } from "../../planning.messages";

/**
 * Отображает готовность и блокирующие ID исключительно из серверного расчёта.
 *
 * Используется для:
 *  - просмотра текущей готовности плана или релиза
 *  - перехода к блокирующим обязательствам
 */
export function PlanningProgress({
  progress,
  error,
  onRefresh,
}: PlanningProgressProps): ReactElement {
  const { projectId } = useProject();
  if (error !== undefined) {
    return (
      <Alert color="red" title={m.readFailure}>
        {errorMessage(error)}
        <Button variant="subtle" onClick={onRefresh}>
          {m.refresh}
        </Button>
      </Alert>
    );
  }
  if (progress === undefined) {
    return <Text role="status">{m.progressUnknown}</Text>;
  }
  return (
    <Card withBorder>
      <Stack gap="xs">
        <Text fw={600}>{m.progress}</Text>
        <Progress value={progress.counts.percent} aria-label={m.progress} />
        <Text size="sm">
          {m.counts(progress.counts.completed, progress.counts.total, progress.counts.percent)}
        </Text>
        <List size="sm">
          {progress.blockers.map((id) => (
            <List.Item key={id}>
              <Anchor component={Link} to={entityHref(projectId, id)}>
                {id}
              </Anchor>
            </List.Item>
          ))}
        </List>
      </Stack>
    </Card>
  );
}
