import type { ReactElement } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Group,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
} from "@mantine/core";
import { useForm, type FormErrors } from "@mantine/form";
import { useCommandDraft, useDraft, useRead, errorMessage } from "domains/project";
import { MutationFeedback } from "domains/knowledge";
import { MarkdownField } from "ui/markdown-field";
import type { DocumentEditorProps } from "./types/document-editor-props.type";
import type { DocumentDraft, DocumentValues } from "../../types/document-editor.types";
import { documentCommand, documentKindOptions, documentStatusOptions } from "domains/documents";
import { documentContent, documentValues } from "../../helpers/editor-values";
import { DocumentRelations } from "../document-relations/document-relations";
import { messages } from "../../config/documents.messages";

/**
 * Сохраняет Markdown, публикацию, раздел и отношения как одну команду документа.
 *
 * Используется для:
 *  - создания и редактирования документа с восстанавливаемым черновиком
 */
export const DocumentEditor = (props: DocumentEditorProps): ReactElement => {
  const scope = `document-editor:${props.source?.entity.id ?? "new"}`;
  const draft = useDraft<DocumentDraft>(scope, {
    source: props.source,
    values: documentValues(props.source, props.sectionId),
  });
  const mutation = useCommandDraft(scope);
  const sections = useRead("documentSections", {});
  const form = useForm<DocumentValues>({
    mode: "uncontrolled",
    initialValues: draft.value.values,
    validateInputOnBlur: true,
    onValuesChange: (values) => draft.setValue({ ...draft.value, values }),
    validate: {
      name: (value) => (value.trim() === "" ? messages.required : null),
      body: (value) => (value.trim() === "" ? messages.required : null),
      relations: { target: (value) => (value === null ? messages.required : null) },
    },
  });
  const sectionId = form.useWatchValue("sectionId");
  const options = (sections.data?.items ?? []).map((section) => ({
    value: section.id,
    label: section.name,
  }));
  if (sectionId !== null && !options.some((option) => option.value === sectionId)) {
    options.push({ value: sectionId, label: sectionId });
  }
  const isLocked = mutation.uncertain || form.submitting;
  const hasSectionsError = sections.error !== undefined;
  const saveLabel = mutation.uncertain ? messages.repeat : messages.save;

  /**
   * Удаляет служебные поля формы и сохраняет исходную ревизию вместе с командой.
   */
  async function save(values: DocumentValues): Promise<void> {
    const result = await mutation.submit(
      documentCommand(draft.value.source, documentContent(values)),
    );
    if (result === undefined) {
      return;
    }
    const document = result.entities.find((entity) => entity.kind === "document");
    draft.reset();
    if (document !== undefined) {
      props.onSaved(document.id);
    } else {
      props.onClose();
    }
  }

  /**
   * Возвращает фокус в обычное поле либо во внутренний редактор Markdown.
   */
  function focusError(errors: FormErrors): void {
    const path = Object.keys(errors)[0];
    if (path === undefined) {
      return;
    }
    const node = form.getInputNode(path);
    const editor = node?.querySelector<HTMLElement>('[contenteditable="true"]');
    (editor ?? node)?.focus();
  }
  return (
    <form onSubmit={form.onSubmit(save, focusError)}>
      <Stack>
        <fieldset disabled={isLocked} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <Stack>
            <TextInput
              label={messages.name}
              required
              key={form.key("name")}
              {...form.getInputProps("name")}
              data-autofocus
            />
            <Textarea
              label={messages.summary}
              autosize
              minRows={2}
              key={form.key("summary")}
              {...form.getInputProps("summary")}
            />
            <Group grow>
              <Select
                label={messages.kind}
                data={documentKindOptions}
                allowDeselect={false}
                key={form.key("documentKind")}
                {...form.getInputProps("documentKind")}
              />
              <Select
                label={messages.status}
                data={documentStatusOptions}
                allowDeselect={false}
                key={form.key("documentStatus")}
                {...form.getInputProps("documentStatus")}
              />
            </Group>
            <Select
              label={messages.section}
              placeholder={messages.noSection}
              data={options}
              clearable
              key={form.key("sectionId")}
              {...form.getInputProps("sectionId")}
            />
            {hasSectionsError && (
              <Alert color="orange">
                {errorMessage(sections.error)}
                <Button variant="subtle" onClick={() => void sections.mutate()}>
                  {messages.retry}
                </Button>
              </Alert>
            )}
            <Checkbox
              label={messages.pin}
              key={form.key("pinned")}
              {...form.getInputProps("pinned", { type: "checkbox" })}
            />
            <MarkdownField
              label={messages.body}
              key={form.key("body")}
              {...form.getInputProps("body")}
              minRows={14}
              disabled={isLocked}
            />
            <DocumentRelations form={form} disabled={isLocked} />
          </Stack>
        </fieldset>
        <Text size="xs" c="dimmed">
          {messages.sourceVersion}
        </Text>
        <MutationFeedback {...mutation} />
        <Group>
          <Button type="submit" loading={mutation.pending || form.submitting}>
            {saveLabel}
          </Button>
          <Button variant="default" onClick={props.onClose}>
            {messages.close}
          </Button>
          <Button
            color="red"
            variant="subtle"
            disabled={isLocked}
            onClick={() => {
              draft.reset();
              mutation.reset();
              props.onClose();
            }}
          >
            {messages.discard}
          </Button>
        </Group>
      </Stack>
    </form>
  );
};
