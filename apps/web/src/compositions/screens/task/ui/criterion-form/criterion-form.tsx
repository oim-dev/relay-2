import { Button, Fieldset, Group, Stack, TextInput, Textarea } from "@mantine/core";
import { useForm } from "@mantine/form";
import type { ReactElement } from "react";
import { useCommandDraft } from "domains/project";
import { CommandFeedback, editTaskCriterionCommand, taskMessages } from "domains/tasks";
import { MarkdownField } from "ui/markdown-field";
import { taskScreenMessages as messages } from "../../config/task-screen.messages";
import type { CriterionValues } from "../../types/task-editor.types";
import type { CriterionFormProps } from "./types/criterion-form-props.type";

/**
 * Редактирует тексты одного критерия без подмены исходной версии задачи.
 *
 * Используется для:
 *  - добавления и частичной правки критерия
 */
export const CriterionForm = ({
  draft,
  name,
  onChange,
  onClose,
}: CriterionFormProps): ReactElement => {
  const action = useCommandDraft(name);
  const form = useForm<CriterionValues>({
    mode: "uncontrolled",
    initialValues: draft.values,
    validateInputOnBlur: true,
    validate: { title: (value) => (value.trim() === "" ? messages.criterionRequired : null) },
    onValuesChange: (values) => onChange({ ...draft, values }),
  });
  const isLocked = action.pending || action.uncertain;
  const label = action.uncertain ? taskMessages.retry : messages.save;

  /**
   * Добавляет новый критерий либо отправляет только изменённые тексты существующего.
   */
  async function submit(values: CriterionValues): Promise<void> {
    const command = editTaskCriterionCommand(draft.snapshot, {
      criterionId: draft.criterionId,
      original: draft.original,
      content: values,
    });
    if (command === undefined) {
      if (!action.uncertain) {
        action.reset();
        onClose();
      }
      return;
    }
    if ((await action.submit(command)) !== undefined) {
      onClose();
    }
  }

  return (
    <form
      onSubmit={form.onSubmit(submit, (errors) => {
        const first = Object.keys(errors)[0];
        if (first !== undefined) {
          form.getInputNode(first)?.focus();
        }
      })}
    >
      <Stack>
        <Fieldset disabled={isLocked} variant="unstyled">
          <Stack>
            <TextInput
              key={form.key("title")}
              autoFocus
              label={messages.criterionTitle}
              required
              {...form.getInputProps("title")}
            />
            <Textarea
              key={form.key("summary")}
              label={messages.criterionSummary}
              autosize
              minRows={2}
              {...form.getInputProps("summary")}
            />
            <MarkdownField
              key={form.key("description")}
              label={messages.criterionDescription}
              disabled={isLocked}
              {...form.getInputProps("description")}
            />
          </Stack>
        </Fieldset>
        <CommandFeedback action={action} />
        <Group>
          <Button type="submit" loading={action.pending}>
            {label}
          </Button>
          <Button
            variant="subtle"
            disabled={isLocked}
            onClick={() => {
              action.reset();
              onClose();
            }}
          >
            {messages.cancel}
          </Button>
        </Group>
      </Stack>
    </form>
  );
};
