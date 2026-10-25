import type { ReactElement } from "react";
import { Button, Group, Select, Stack, Text, TextInput, Textarea } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useCommandDraft, useDraft } from "domains/project";
import {
  EntityPicker,
  MutationFeedback,
  applicationOptions,
  implementationOptions,
  knowledgeCommand,
} from "domains/knowledge";
import { MarkdownField } from "ui/markdown-field";
import type { KnowledgeEditorProps } from "./types/knowledge-editor-props.type";
import type { KnowledgeEditorDraft, KnowledgeValues } from "../../types/editor.types";
import { knowledgeEditorScope, knowledgeValues, knowledgeWrite } from "../../helpers/editor-values";
import { messages } from "../../config/knowledge-screen.messages";

/**
 * Редактирует описание знания с первоначальной версией и сохраняемым вводом.
 *
 * Используется для:
 *  - создания фич, сценариев, приложений и реализаций
 *  - изменения описания и реального состояния реализации
 */
export const KnowledgeEditor = (props: KnowledgeEditorProps): ReactElement => {
  const scope = knowledgeEditorScope(props.kind, props.source, props.owner?.entity.id ?? null);
  const draft = useDraft<KnowledgeEditorDraft>(scope, {
    kind: props.kind,
    source: props.source,
    owner: props.owner,
    values: knowledgeValues(props.source),
  });
  const mutation = useCommandDraft(scope);
  const form = useForm<KnowledgeValues>({
    mode: "uncontrolled",
    initialValues: draft.value.values,
    validateInputOnBlur: true,
    onValuesChange: (values) => draft.setValue({ ...draft.value, values }),
    validate: {
      name: (value) => (value.trim() === "" ? messages.required : null),
      slug: (value) =>
        props.kind === "application" && props.source === null && value.trim() === ""
          ? messages.required
          : null,
      feature: (value) =>
        props.kind === "scenario" && props.source === null && value === null
          ? messages.required
          : null,
      target: (value) =>
        props.kind === "implementation" && props.source === null && value === null
          ? messages.required
          : null,
    },
  });
  const feature = form.useWatchValue("feature");
  const target = form.useWatchValue("target");
  const targetKind = form.useWatchValue("targetKind");
  const isCreating = draft.value.source === null;
  const isApplication = props.kind === "application";
  const isImplementation = props.kind === "implementation";
  const needsFeature = props.kind === "scenario" && isCreating;
  const needsTarget = isImplementation && isCreating;
  const needsAddress = isApplication && isCreating;
  const hasSummary = !isImplementation;
  const isLocked = mutation.uncertain || form.submitting;
  const saveLabel = mutation.uncertain ? messages.repeat : messages.save;
  const nameLabel = isImplementation ? messages.titleField : messages.name;

  /**
   * Отправляет поля действия с сохранёнными guard; успех завершает именно этот черновик.
   */
  async function save(values: KnowledgeValues): Promise<void> {
    const result = await mutation.submit(knowledgeCommand(knowledgeWrite(draft.value, values)));
    if (result === undefined) {
      return;
    }
    const entity = result.entities.find((item) => item.kind === props.kind);
    draft.reset();
    if (entity !== undefined) {
      props.onSaved(entity.id);
    } else {
      props.onClose();
    }
  }

  /**
   * Отбрасывает известный ввод только по явному действию пользователя.
   */
  function discard(): void {
    draft.reset();
    mutation.reset();
    props.onClose();
  }

  return (
    <form
      onSubmit={form.onSubmit(save, (errors) =>
        form.getInputNode(Object.keys(errors)[0] ?? "name")?.focus(),
      )}
    >
      <Stack>
        <fieldset disabled={isLocked} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <Stack>
            <TextInput
              label={nameLabel}
              required
              key={form.key("name")}
              {...form.getInputProps("name")}
              data-autofocus
            />
            {hasSummary && (
              <Textarea
                label={messages.summary}
                autosize
                minRows={2}
                key={form.key("summary")}
                {...form.getInputProps("summary")}
              />
            )}
            {needsFeature && (
              <EntityPicker
                kind="feature"
                label={messages.feature}
                value={feature}
                onChange={(id) => form.setFieldValue("feature", id)}
                field={form.getInputProps("feature")}
                disabled={isLocked}
              />
            )}
            {needsAddress && (
              <Group grow>
                <TextInput
                  label={messages.slug}
                  required
                  key={form.key("slug")}
                  {...form.getInputProps("slug")}
                />
                <TextInput
                  label={messages.prefix}
                  key={form.key("prefix")}
                  {...form.getInputProps("prefix")}
                />
              </Group>
            )}
            {isApplication && (
              <Select
                label={messages.applicationType}
                data={applicationOptions}
                allowDeselect={false}
                key={form.key("type")}
                {...form.getInputProps("type")}
              />
            )}
            {needsTarget && (
              <Stack gap="xs">
                <Select
                  label={messages.targetKind}
                  value={targetKind}
                  data={[
                    { value: "feature", label: messages.featureTarget },
                    { value: "scenario", label: messages.scenarioTarget },
                  ]}
                  allowDeselect={false}
                  onChange={(value) => {
                    if (value === "feature" || value === "scenario") {
                      form.setFieldValue("targetKind", value);
                      form.setFieldValue("target", null);
                    }
                  }}
                />
                <EntityPicker
                  kind={targetKind}
                  label={messages.target}
                  value={target}
                  onChange={(id) => form.setFieldValue("target", id)}
                  field={form.getInputProps("target")}
                  disabled={isLocked}
                />
              </Stack>
            )}
            {isImplementation && (
              <Select
                label={messages.status}
                data={implementationOptions}
                allowDeselect={false}
                key={form.key("status")}
                {...form.getInputProps("status")}
              />
            )}
            <MarkdownField
              label={messages.descriptionField}
              key={form.key("description")}
              {...form.getInputProps("description")}
              disabled={isLocked}
              minRows={8}
            />
          </Stack>
        </fieldset>
        <Text size="xs" c="dimmed">
          {messages.noChanges}
        </Text>
        <MutationFeedback {...mutation} />
        <Group>
          <Button type="submit" loading={form.submitting || mutation.pending}>
            {saveLabel}
          </Button>
          <Button variant="default" onClick={props.onClose}>
            {messages.close}
          </Button>
          <Button color="red" variant="subtle" onClick={discard} disabled={isLocked}>
            {messages.discard}
          </Button>
        </Group>
      </Stack>
    </form>
  );
};
