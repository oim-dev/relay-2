import { Badge, Button, Group, Paper, Stack, Text } from "@mantine/core";
import type { ReactElement } from "react";
import { MarkdownView } from "ui/markdown-view";
import { taskScreenMessages as messages } from "../../config/task-screen.messages";
import type { CriterionRowProps } from "./types/criterion-row-props.type";

/**
 * Показывает содержание, отметку и доступные действия одного критерия.
 *
 * Используется для:
 *  - чтения и выбора действия в списке критериев карточки задачи
 */
export const CriterionRow = ({
  criterion,
  disabled,
  onToggle,
  onEdit,
  onRemove,
}: CriterionRowProps): ReactElement => {
  const status = criterion.completed ? messages.criterionDone : messages.criterionPending;
  const color = criterion.completed ? "teal" : "gray";
  const checkLabel = criterion.completed ? messages.criterionReopen : messages.criterionComplete;
  return (
    <Paper withBorder p="sm">
      <Stack gap="xs">
        <Group justify="space-between" align="flex-start">
          <Text fw={600} style={{ overflowWrap: "anywhere" }}>
            {criterion.title}
          </Text>
          <Badge color={color} variant="light">
            {status}
          </Badge>
        </Group>
        <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
          {criterion.summary}
        </Text>
        <MarkdownView text={criterion.description} headingStartLevel={3} />
        <Group gap="xs">
          <Button size="compact-xs" variant="subtle" disabled={disabled} onClick={onToggle}>
            {checkLabel}
          </Button>
          <Button size="compact-xs" variant="subtle" disabled={disabled} onClick={onEdit}>
            {messages.edit}
          </Button>
          <Button
            size="compact-xs"
            variant="subtle"
            color="red"
            disabled={disabled}
            onClick={onRemove}
          >
            {messages.criterionRemove}
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
};
