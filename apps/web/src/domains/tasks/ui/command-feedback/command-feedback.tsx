import { Alert, Stack, Text } from "@mantine/core";
import type { ReactElement } from "react";
import type { CommandFeedbackProps } from "./types/command-feedback-props.type";
import { taskMessages } from "../../config/tasks.messages";

/**
 * Показывает отказ и сохранённую неопределённую попытку.
 *
 * Используется для:
 *  - объяснения блокировки формы и безопасного повтора
 */
export const CommandFeedback = ({ action }: CommandFeedbackProps): ReactElement | null => {
  if (action.pending || (action.error === undefined && !action.uncertain)) {
    return null;
  }
  const color = action.uncertain ? "orange" : "red";
  const title = action.uncertain ? taskMessages.unknownOutcome : taskMessages.failure;
  return (
    <Alert color={color} title={title} role="alert">
      <Stack gap="xs">
        <Text size="sm">{action.error}</Text>
        {action.uncertain && <Text size="sm">{taskMessages.uncertain}</Text>}
      </Stack>
    </Alert>
  );
};
