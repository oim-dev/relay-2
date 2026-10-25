import { Button, Fieldset, Select, Stack, Text, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { TASK_COLUMNS } from "@relay/contracts";
import type { ReactElement } from "react";
import { useCommandDraft, useDraft } from "domains/project";
import { MarkdownField } from "ui/markdown-field";
import { taskColumnLabels, taskMessages } from "../../config/tasks.messages";
import { createTaskCommand, taskColumn } from "../../operations/task-commands";
import type { TaskCreateDraft, TaskCreateValues } from "../../types/tasks.types";
import { CommandFeedback } from "../command-feedback/command-feedback";
import type { TaskCreateFormProps } from "./types/task-create-form-props.type";

/**
 * Создаёт задачу из сохраняемого Markdown-черновика.
 *
 * Используется для:
 *  - создания на доске и добавления прямого ребёнка
 *  - восстановления исхода без повторного создания задачи
 */
export const TaskCreateForm = ({
  boardId,
  parentId,
  onCreated,
}: TaskCreateFormProps): ReactElement => {
  const name = `task-create:${parentId ?? boardId}`;
  const draft = useDraft<TaskCreateDraft>(name, {
    boardId,
    values: { title: "", description: "", column: "inbox" },
  });
  const action = useCommandDraft(name);
  const form = useForm<TaskCreateValues>({
    mode: "uncontrolled",
    initialValues: draft.value.values,
    onValuesChange: (values) => draft.setValue({ ...draft.value, values }),
  });
  const isLocked = action.pending || action.uncertain;
  const buttonLabel = action.uncertain ? taskMessages.retry : taskMessages.create;

  /**
   * Посылает только поля создания; Core проверяет родителя, граф и колонку.
   */
  async function submit(values: TaskCreateValues): Promise<void> {
    const column = taskColumn(values.column);
    if (column === undefined) {
      form.setFieldError("column", taskMessages.unknownColumn);
      return;
    }
    const result = await action.submit(
      createTaskCommand({
        boardId: draft.value.boardId,
        title: values.title,
        description: values.description,
        column,
        ...(parentId === undefined ? {} : { parentId }),
      }),
    );
    const created = result?.items.find((item) => item.op === "task.create");
    if (created !== undefined) {
      draft.reset();
      onCreated(created.id);
    }
  }

  return (
    <form onSubmit={form.onSubmit(submit)}>
      <Stack>
        <Fieldset disabled={isLocked} variant="unstyled">
          <Stack>
            <TextInput
              key={form.key("title")}
              label={taskMessages.title}
              {...form.getInputProps("title")}
            />
            <MarkdownField
              key={form.key("description")}
              label={taskMessages.description}
              disabled={isLocked}
              {...form.getInputProps("description")}
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
        <Text size="xs" c="dimmed">
          {taskMessages.draft}
        </Text>
        <CommandFeedback action={action} />
        <Button type="submit" loading={action.pending}>
          {buttonLabel}
        </Button>
      </Stack>
    </form>
  );
};
