import type { ReactElement } from "react";
import { Alert, Button, Fieldset, Group, Modal, Stack, TextInput, Textarea } from "@mantine/core";
import { useForm } from "@mantine/form";
import { stageCommand, type StageSource } from "domains/planning";
import { useCommandDraft, useDraft } from "domains/project";
import { MarkdownField } from "ui/markdown-field";
import type { PlanningDraft, StageFormProps, StageFormValues } from "../../planning-form.types";
import { planningMessages as m } from "../../planning.messages";

/**
 * Редактирует тексты этапа, защищённые ревизией плана.
 *
 * Используется для:
 *  - создания пустого этапа
 *  - изменения ожидаемого итога и условий завершения
 */
export function StageForm({ source, onClose }: StageFormProps): ReactElement {
  const name = `stage-form:${source.entity.id}:${source.stage?.id ?? "new"}`;
  const draft = useDraft<PlanningDraft<StageFormValues, StageSource>>(name, {
    source,
    values: source.stage ?? { title: "", summary: "", outcome: "", completionConditions: "" },
  });
  const command = useCommandDraft(name);
  const form = useForm<StageFormValues>({
    mode: "uncontrolled",
    initialValues: draft.value.values,
    validateInputOnBlur: true,
    validate: { title: (v) => (v.trim() === "" ? m.required : null) },
    onValuesChange: (values) => draft.setValue({ ...draft.value, values }),
  });
  const isLocked = command.pending || command.uncertain;
  const submitLabel = command.uncertain ? m.retry : m.save;
  /**
   * Передаёт только текстовые поля: ID и состав этапа не являются редактируемыми полями.
   */
  async function save(values: StageFormValues): Promise<void> {
    const fields = {
      title: values.title,
      summary: values.summary,
      outcome: values.outcome,
      completionConditions: values.completionConditions,
    };
    const original = draft.value.source;
    const change =
      original.stage === undefined
        ? { action: "create" as const, fields, before: null }
        : { action: "update" as const, stageId: original.stage.id, fields };
    if ((await command.submit(stageCommand(original, change))) !== undefined) {
      draft.reset();
      onClose();
    }
  }
  return (
    <Modal
      opened
      title={m.stage}
      onClose={onClose}
      size="lg"
      closeButtonProps={{ "aria-label": m.close }}
      attributes={{ header: { role: "presentation" } }}
    >
      <form
        onSubmit={form.onSubmit(save, (errors) => {
          const path = Object.keys(errors)[0];
          if (path !== undefined) {
            form.getInputNode(path)?.focus();
          }
        })}
      >
        <Stack>
          <Fieldset disabled={isLocked}>
            <Stack>
              <TextInput
                label={m.title}
                required
                data-autofocus
                key={form.key("title")}
                {...form.getInputProps("title")}
              />
              <Textarea
                label={m.summary}
                autosize
                key={form.key("summary")}
                {...form.getInputProps("summary")}
              />
              <MarkdownField
                label={m.outcome}
                key={form.key("outcome")}
                {...form.getInputProps("outcome")}
                disabled={isLocked}
              />
              <MarkdownField
                label={m.conditions}
                key={form.key("completionConditions")}
                {...form.getInputProps("completionConditions")}
                disabled={isLocked}
              />
            </Stack>
          </Fieldset>
          {command.error !== undefined && <Alert color="red">{command.error}</Alert>}
          {command.uncertain && <Alert color="orange">{m.uncertain}</Alert>}
          <Group justify="space-between">
            <Button
              variant="subtle"
              disabled={isLocked}
              onClick={() => {
                draft.reset();
                command.reset();
                onClose();
              }}
            >
              {m.discard}
            </Button>
            <Group>
              <Button variant="default" onClick={onClose}>
                {m.close}
              </Button>
              <Button type="submit" loading={command.pending}>
                {submitLabel}
              </Button>
            </Group>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
