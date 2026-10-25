import { useState, type ReactElement } from "react";
import { Link } from "react-router-dom";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  List,
  Progress,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { errorMessage, useProject, useRead } from "domains/project";
import { MarkdownView } from "ui/markdown-view";
import { StageForm } from "../stage-form/stage-form";
import { MembershipForm } from "../membership-form/membership-form";
import type { StageCardProps } from "../../planning-form.types";
import { planningMessages as m } from "../../planning.messages";

/**
 * Показывает этап, его задачи и операции с ревизией плана-владельца.
 *
 * Используется для:
 *  - чтения состава этапа по требованию
 *  - перестановки этапов и открытия редакторов состава
 */
export function StageCard({
  source,
  stage,
  percent,
  locked,
  onChange,
}: StageCardProps): ReactElement {
  const { projectId } = useProject();
  const [editing, setEditing] = useState(false);
  const [membership, setMembership] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const tasks = useRead(
    "planStageTasks",
    expanded ? { ref: source.entity.id, stageId: stage.id } : undefined,
  );
  const isMutable = source.entity.data.status === "draft" || source.entity.data.status === "active";
  const isLocked = locked;
  const tasksLabel = expanded ? m.hideTasks : m.showTasks;
  const isEmpty = expanded && tasks.data !== undefined && !tasks.data.items.some(Boolean);
  const snapshot = { ...source, stage };
  return (
    <Card withBorder>
      <Stack>
        <Group justify="space-between">
          <Title order={3} size="h4">
            {stage.title}
          </Title>
          <Badge variant="light">{stage.taskIds.length}</Badge>
        </Group>
        <Text size="sm">{stage.summary}</Text>
        <MarkdownView text={stage.outcome} compact />
        <MarkdownView text={stage.completionConditions} compact />
        {percent !== undefined && <Progress value={percent} aria-label={m.progress} />}
        <Group gap="xs">
          <Button variant="subtle" size="xs" onClick={() => setExpanded(!expanded)}>
            {tasksLabel}
          </Button>
          {isMutable && (
            <>
              <Button
                variant="default"
                size="xs"
                disabled={isLocked}
                onClick={() => setEditing(true)}
              >
                {m.edit}
              </Button>
              <Button
                variant="default"
                size="xs"
                disabled={isLocked}
                onClick={() => setMembership(true)}
              >
                {m.tasks}
              </Button>
              <Button
                variant="subtle"
                size="xs"
                disabled={isLocked}
                onClick={() =>
                  onChange({ action: "move", stageId: stage.id, destination: { direction: "up" } })
                }
              >
                {m.up}
              </Button>
              <Button
                variant="subtle"
                size="xs"
                disabled={isLocked}
                onClick={() =>
                  onChange({
                    action: "move",
                    stageId: stage.id,
                    destination: { direction: "down" },
                  })
                }
              >
                {m.down}
              </Button>
              <Button
                color="red"
                variant="subtle"
                size="xs"
                disabled={isLocked || stage.taskIds.some(Boolean)}
                onClick={() => onChange({ action: "remove", stageId: stage.id })}
              >
                {m.removeStage}
              </Button>
            </>
          )}
        </Group>
        {tasks.error !== undefined && (
          <Alert color="red">
            {errorMessage(tasks.error)}
            <Button variant="subtle" onClick={() => void tasks.mutate()}>
              {m.refresh}
            </Button>
          </Alert>
        )}
        {tasks.isLoading && <Text role="status">{m.loading}</Text>}
        {isEmpty && <Text c="dimmed">{m.noTasks}</Text>}
        {expanded && (
          <List>
            {tasks.data?.items.map((task) => (
              <List.Item key={task.id}>
                <Anchor component={Link} to={`/projects/${projectId}/tasks/${task.id}`}>
                  {task.key} · {task.data.title}
                </Anchor>
              </List.Item>
            ))}
          </List>
        )}
        {editing && <StageForm source={snapshot} onClose={() => setEditing(false)} />}
        {membership && <MembershipForm source={snapshot} onClose={() => setMembership(false)} />}
      </Stack>
    </Card>
  );
}
