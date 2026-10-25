import { Alert, Button, Fieldset, Group, Paper, Select, Stack, Title } from "@mantine/core";
import { useForm } from "@mantine/form";
import { TASK_COLUMNS } from "@relay/contracts";
import type { ReactElement } from "react";
import { useCommandDraft, useDraft } from "domains/project";
import {
  CommandFeedback,
  EntityReference,
  ReferencePicker,
  taskColumn,
  taskColumnLabels,
  moveTaskCommand,
  taskMessages,
} from "domains/tasks";
import { taskScreenMessages as messages } from "../../config/task-screen.messages";
import type {
  TaskMoveDraft,
  TaskMoveValues,
  TaskSectionProps,
} from "../../types/task-editor.types";

/**
 * Перемещает задачу отдельно от изменения её содержания.
 *
 * Используется для:
 *  - выбора текущей колонки или другой доски с исходными guards
 */
export const TaskMove = ({ snapshot }: TaskSectionProps): ReactElement => {
  const name = `task-move:${snapshot.task.id}`;
  const draft = useDraft<TaskMoveDraft | null>(name, null);
  const action = useCommandDraft(name);
  const initial = { board: snapshot.task.data.boardId, column: snapshot.task.data.column };
  const form = useForm<TaskMoveValues>({
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
  const submitLabel = action.uncertain ? taskMessages.retry : messages.move;

  /**
   * Передаёт только изменённые поля размещения, не смешивая их с title/description.
   */
  async function submit(values: TaskMoveValues): Promise<void> {
    const current = draft.value;
    if (current === null) {
      return;
    }
    const column = taskColumn(values.column);
    if (column === undefined) {
      form.setFieldError("column", taskMessages.unknownColumn);
      return;
    }
    const command = moveTaskCommand(current.snapshot, { boardId: values.board, column });
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
          <Title order={2} size="h4">
            {messages.boardField}
          </Title>
          <EntityReference id={snapshot.task.data.boardId} />
          <Button
            variant="light"
            onClick={() => {
              draft.setValue({ snapshot, values: initial });
              form.setValues(initial);
              action.reset();
            }}
          >
            {messages.move}
          </Button>
        </Stack>
      </Paper>
    );
  }
  return (
    <Paper withBorder p="md">
      <form onSubmit={form.onSubmit(submit)}>
        <Stack>
          {hasChanged && <Alert color="orange">{taskMessages.snapshotChanged}</Alert>}
          <Fieldset variant="unstyled" disabled={isLocked}>
            <Stack>
              <ReferencePicker
                key={form.key("board")}
                kind="board"
                label={messages.boardField}
                disabled={isLocked}
                {...form.getInputProps("board")}
              />
              <Select
                key={form.key("column")}
                label={taskMessages.column}
                allowDeselect={false}
                data={TASK_COLUMNS.map((value) => ({ value, label: taskColumnLabels[value] }))}
                {...form.getInputProps("column")}
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
