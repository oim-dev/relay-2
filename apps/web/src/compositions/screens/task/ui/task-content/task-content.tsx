import { Alert, Button, Fieldset, Group, Paper, Stack, TextInput, Title } from "@mantine/core";
import { useForm } from "@mantine/form";
import type { ReactElement } from "react";
import { useCommandDraft, useDraft } from "domains/project";
import { CommandFeedback, updateTaskContentCommand, taskMessages } from "domains/tasks";
import { MarkdownField } from "ui/markdown-field";
import { MarkdownView } from "ui/markdown-view";
import { taskScreenMessages as messages } from "../../config/task-screen.messages";
import type {
  TaskContentDraft,
  TaskContentValues,
  TaskSectionProps,
} from "../../types/task-editor.types";

/**
 * Показывает Markdown и отдельно редактирует текст с исходной версией.
 *
 * Используется для:
 *  - сохранения черновика при SSE, навигации и отказе записи
 */
export const TaskContent = ({ snapshot }: TaskSectionProps): ReactElement => {
  const name = `task-content:${snapshot.task.id}`;
  const draft = useDraft<TaskContentDraft | null>(name, null);
  const action = useCommandDraft(name);
  const initial = { title: snapshot.task.data.title, description: snapshot.task.data.description };
  const form = useForm<TaskContentValues>({
    mode: "uncontrolled",
    initialValues: draft.value?.values ?? initial,
    onValuesChange: (values) => {
      if (draft.value !== null) {
        draft.setValue({ ...draft.value, values });
      }
    },
  });
  const isLocked = action.pending || action.uncertain;
  const hasChanged =
    draft.value !== null && draft.value.snapshot.task.revision !== snapshot.task.revision;
  const submitLabel = action.uncertain ? taskMessages.retry : messages.save;

  /**
   * Фиксирует карточку и обе версии только при явном начале нового редактирования.
   */
  function begin(): void {
    draft.setValue({ snapshot, values: initial });
    form.setValues(initial);
    action.reset();
  }

  /**
   * Отправляет только изменённые текстовые поля; исходный снимок остаётся неизменным.
   */
  async function submit(values: TaskContentValues): Promise<void> {
    const current = draft.value;
    if (current === null) {
      return;
    }
    const command = updateTaskContentCommand(current.snapshot, values);
    if (command === undefined) {
      if (!action.uncertain) {
        draft.setValue(null);
      }
      return;
    }
    const result = await action.submit(command);
    if (result !== undefined) {
      draft.setValue(null);
    }
  }

  if (draft.value === null) {
    return (
      <Paper withBorder p="md">
        <Stack>
          <Group justify="space-between">
            <Title order={2} size="h4">
              {messages.description}
            </Title>
            <Button variant="subtle" onClick={begin}>
              {messages.edit}
            </Button>
          </Group>
          <MarkdownView
            text={snapshot.task.data.description}
            emptyText={messages.noDescription}
            headingStartLevel={2}
          />
        </Stack>
      </Paper>
    );
  }
  return (
    <Paper withBorder p="md">
      <form onSubmit={form.onSubmit(submit)}>
        <Stack>
          <Title order={2} size="h4">
            {messages.description}
          </Title>
          {hasChanged && <Alert color="orange">{taskMessages.snapshotChanged}</Alert>}
          <Fieldset variant="unstyled" disabled={isLocked}>
            <Stack>
              <TextInput
                key={form.key("title")}
                autoFocus
                label={taskMessages.title}
                {...form.getInputProps("title")}
              />
              <MarkdownField
                key={form.key("description")}
                label={taskMessages.description}
                minRows={10}
                disabled={isLocked}
                {...form.getInputProps("description")}
              />
            </Stack>
          </Fieldset>
          <CommandFeedback action={action} />
          <Group>
            <Button type="submit" loading={action.pending}>
              {submitLabel}
            </Button>
            <Button
              variant="subtle"
              disabled={isLocked}
              onClick={() => {
                draft.setValue(null);
                action.reset();
              }}
            >
              {messages.cancel}
            </Button>
          </Group>
        </Stack>
      </form>
    </Paper>
  );
};
