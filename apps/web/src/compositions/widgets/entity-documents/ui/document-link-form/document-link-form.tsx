import type { ReactElement } from "react";
import { Button, Group, Select, Stack, Text, Textarea } from "@mantine/core";
import { useForm } from "@mantine/form";
import { EntityLink, MutationFeedback } from "domains/knowledge";
import { relationLabel, relationOptions } from "domains/documents";
import type { DocumentLinkFormProps } from "./types/document-link-form-props.type";
import type { MaterialValues } from "../../types/entity-documents-props.type";
import { messages } from "../../config/entity-documents.messages";

/**
 * Редактирует одну связь документа, сохраняя значения и исход операции у виджета.
 *
 * Используется для:
 *  - прикрепления материала с пояснением
 *  - снятия выбранной связи и повторной проверки неопределённой записи
 */
export const DocumentLinkForm = (props: DocumentLinkFormProps): ReactElement => {
  const form = useForm<MaterialValues>({
    mode: "uncontrolled",
    initialValues: props.editor.values,
    onValuesChange: props.onValuesChange,
  });
  const isLink = props.editor.action === "link";
  const isUnlink = props.editor.action === "unlink";
  const isLocked = props.mutation.uncertain || props.mutation.pending || form.submitting;
  let saveLabel = isLink ? messages.attach : messages.unlink;
  if (props.mutation.uncertain) {
    saveLabel = messages.repeat;
  }
  return (
    <form onSubmit={form.onSubmit(props.onSubmit)}>
      <Stack>
        <Text size="sm" c="dimmed">
          {messages.owner}
        </Text>
        <EntityLink id={props.editor.source.entity.id} />
        <Text size="sm" c="dimmed">
          {messages.target}
        </Text>
        <EntityLink id={props.target.id} />
        <Text size="xs" c="dimmed">
          {messages.guard}
        </Text>
        {isLink && (
          <fieldset disabled={isLocked} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
            <Stack>
              <Select
                label={messages.relationType}
                data={relationOptions}
                allowDeselect={false}
                key={form.key("type")}
                {...form.getInputProps("type")}
              />
              <Textarea
                label={messages.description}
                autosize
                minRows={2}
                key={form.key("description")}
                {...form.getInputProps("description")}
              />
            </Stack>
          </fieldset>
        )}
        {isUnlink && (
          <Stack gap="xs">
            <Text fw={600}>{relationLabel(props.editor.values.type)}</Text>
            <Text size="sm">{messages.removeHelp}</Text>
          </Stack>
        )}
        <MutationFeedback {...props.mutation} />
        <Group>
          <Button type="submit" loading={props.mutation.pending || form.submitting}>
            {saveLabel}
          </Button>
          <Button variant="default" onClick={props.onClose}>
            {messages.close}
          </Button>
          <Button color="red" variant="subtle" disabled={isLocked} onClick={props.onDiscard}>
            {messages.discard}
          </Button>
        </Group>
      </Stack>
    </form>
  );
};
