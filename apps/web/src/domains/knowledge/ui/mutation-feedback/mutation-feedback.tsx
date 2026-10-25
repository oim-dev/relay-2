import type { ReactElement } from "react";
import { Alert, Text } from "@mantine/core";
import type { MutationFeedbackProps } from "./types/mutation-feedback-props.type";
import { knowledgeMessages as messages } from "../../config/knowledge.messages";

/**
 * Объясняет отказ записи и сохранность неопределённой операции.
 *
 * Используется для:
 *  - восстановления формы после транспортного сбоя или предметного конфликта
 */
export const MutationFeedback = (props: MutationFeedbackProps): ReactElement | null => {
  if (props.error === undefined && (!props.uncertain || props.pending)) {
    return null;
  }
  const isUncertain = props.uncertain && !props.pending;
  return (
    <Alert color="orange" title={messages.operation}>
      <Text size="sm">{props.error}</Text>
      {isUncertain && (
        <Text size="sm" mt="xs">
          {messages.uncertain}
        </Text>
      )}
    </Alert>
  );
};
