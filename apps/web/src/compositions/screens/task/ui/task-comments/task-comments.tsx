import { Alert, Button, Fieldset, Paper, Stack, Text, TextInput, Title } from "@mantine/core";
import { useForm } from "@mantine/form";
import type { ReactElement } from "react";
import { useCommandDraft, useDraft, useRead } from "domains/project";
import { CommandFeedback, addTaskCommentCommand, taskMessages } from "domains/tasks";
import { MarkdownField } from "ui/markdown-field";
import { MarkdownView } from "ui/markdown-view";
import { isEmptyArray } from "shared/value-predicates";
import { taskScreenMessages as messages } from "../../config/task-screen.messages";
import type { CommentValues, TaskSectionProps } from "../../types/task-editor.types";

/**
 * Читает и дописывает независимый append-only журнал задачи.
 *
 * Используется для:
 *  - добавления Markdown-комментария без CAS содержания
 *  - восстановления результата публикации без повторного комментария
 */
export const TaskComments = ({ snapshot }: TaskSectionProps): ReactElement => {
  const name = `task-comment:${snapshot.task.id}`;
  const query = useRead("taskComments", { ref: snapshot.task.id });
  const draft = useDraft<CommentValues>(name, { title: "", body: "" });
  const action = useCommandDraft(name);
  const form = useForm<CommentValues>({
    mode: "uncontrolled",
    initialValues: draft.value,
    onValuesChange: draft.setValue,
    validateInputOnBlur: true,
    validate: { body: (value) => (value.trim() === "" ? messages.commentRequired : null) },
  });
  const isLocked = action.pending || action.uncertain;
  const label = action.uncertain ? taskMessages.retry : messages.commentAdd;
  const commentItems = query.data?.items ?? snapshot.task.data.comments;
  const isEmpty = isEmptyArray(commentItems);

  /**
   * Публикует только title/body, не отправляя устаревшую проекцию журнала или CAS задачи.
   */
  async function submit(values: CommentValues): Promise<void> {
    const result = await action.submit(addTaskCommentCommand(snapshot.task.id, values));
    if (result !== undefined) {
      const empty = { title: "", body: "" };
      draft.setValue(empty);
      form.setValues(empty);
      form.resetDirty(empty);
    }
  }

  return (
    <Paper withBorder p="md">
      <Stack>
        <Title order={2} size="h4">
          {messages.comments}
        </Title>
        <Text size="xs" c="dimmed">
          {messages.commentsImmutable}
        </Text>
        {query.error !== undefined && (
          <Alert color="orange" title={messages.projectionError}>
            <Button variant="subtle" onClick={() => void query.mutate()}>
              {messages.reload}
            </Button>
          </Alert>
        )}
        {isEmpty && (
          <Text size="sm" c="dimmed">
            {messages.commentsEmpty}
          </Text>
        )}
        {commentItems.map((comment) => (
          <Paper withBorder p="sm" key={comment.id}>
            <Stack gap="xs">
              <Text size="xs" c="dimmed">
                {comment.createdBy} · {new Date(comment.createdAt).toLocaleString("ru-RU")}
              </Text>
              <Text fw={600}>{comment.title}</Text>
              <MarkdownView text={comment.body} headingStartLevel={3} />
            </Stack>
          </Paper>
        ))}
        <form onSubmit={form.onSubmit(submit)}>
          <Stack>
            <Fieldset disabled={isLocked} variant="unstyled">
              <Stack>
                <TextInput
                  key={form.key("title")}
                  label={messages.commentTitle}
                  {...form.getInputProps("title")}
                />
                <MarkdownField
                  key={form.key("body")}
                  label={messages.commentBody}
                  disabled={isLocked}
                  {...form.getInputProps("body")}
                />
              </Stack>
            </Fieldset>
            <CommandFeedback action={action} />
            <Button type="submit" loading={action.pending}>
              {label}
            </Button>
          </Stack>
        </form>
      </Stack>
    </Paper>
  );
};
