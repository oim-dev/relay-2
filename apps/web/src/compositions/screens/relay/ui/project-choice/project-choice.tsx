import type { ReactElement } from "react";
import { Link } from "react-router-dom";
import { Badge, Button, Card, Group, Stack, Text } from "@mantine/core";
import { relayMessages as m } from "../../relay.messages";
import type { ProjectChoiceProps } from "./types/project-choice-props.type";

/**
 * Показывает одну регистрацию workspace и доступный переход к её проекту.
 *
 * Используется для:
 *  - сохранения недоступных регистраций вместе с исходной диагностикой
 */
export function ProjectChoice({ project }: ProjectChoiceProps): ReactElement {
  const canOpen = project.available && project.id !== null;
  const availability = project.available ? m.available : m.unavailable;
  const color = project.available ? "teal" : "gray";
  const description = project.slug ?? project.error?.message ?? m.unavailable;
  const href = `/projects/${encodeURIComponent(project.id ?? "")}`;
  return (
    <Card withBorder padding="lg">
      <Stack>
        <Group justify="space-between">
          <Text fw={600}>{project.name}</Text>
          <Badge color={color}>{availability}</Badge>
        </Group>
        <Text size="sm" c="dimmed">
          {description}
        </Text>
        {canOpen && (
          <Button component={Link} to={href} variant="light">
            {m.open}
          </Button>
        )}
        {!canOpen && <Button disabled>{m.unavailable}</Button>}
      </Stack>
    </Card>
  );
}
