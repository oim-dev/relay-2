import type { ReactElement } from "react";
import { Button, Group, Select, Stack, Text, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useCommandDraft, useDraft } from "domains/project";
import { MutationFeedback } from "domains/knowledge";
import { sectionCommand } from "domains/documents";
import { sectionChange } from "../../helpers/editor-values";
import type {
  SectionDraft,
  SectionEditorProps,
  SectionValues,
} from "./types/section-editor-props.type";
import { messages } from "../../config/documents.messages";

const actions = [
  { value: "create", label: messages.sectionCreate },
  { value: "update", label: messages.sectionUpdate },
  { value: "move", label: messages.sectionMove },
  { value: "remove", label: messages.sectionRemove },
];

/**
 * Изменяет разделы библиотеки под исходной ревизией проекта.
 *
 * Используется для:
 *  - создания, переименования, перестановки и снятия разделов
 */
export const SectionEditor = (props: SectionEditorProps): ReactElement => {
  const scope = "document-section-editor";
  const draft = useDraft<SectionDraft>(scope, {
    source: props.source,
    values: { action: "create", id: null, name: "", before: null },
  });
  const mutation = useCommandDraft(scope);
  const form = useForm<SectionValues>({
    mode: "uncontrolled",
    initialValues: draft.value.values,
    validateInputOnBlur: true,
    onValuesChange: (values) => draft.setValue({ ...draft.value, values }),
    validate: {
      id: (value, values) =>
        values.action !== "create" && value === null ? messages.required : null,
      name: (value, values) =>
        (values.action === "create" || values.action === "update") && value.trim() === ""
          ? messages.required
          : null,
    },
  });
  const action = form.useWatchValue("action");
  const id = form.useWatchValue("id");
  const source = draft.value.source.entity;
  const options =
    source.kind === "project"
      ? (source.data.documentSections ?? []).map((section) => ({
          value: section.id,
          label: section.name,
        }))
      : [];
  const beforeOptions = options.filter((option) => option.value !== id);
  const needsName = action === "create" || action === "update";
  const needsId = action !== "create";
  const isMove = action === "move";
  const isLocked = mutation.uncertain || form.submitting;
  const saveLabel = mutation.uncertain ? messages.repeat : messages.save;

  /**
   * Сохраняет действие каталога по опубликованному имени document.section.*.
   */
  async function save(values: SectionValues): Promise<void> {
    const result = await mutation.submit(sectionCommand(draft.value.source, sectionChange(values)));
    if (result !== undefined) {
      draft.reset();
      props.onSaved();
    }
  }
  return (
    <form
      onSubmit={form.onSubmit(save, (errors) =>
        form.getInputNode(Object.keys(errors)[0] ?? "name")?.focus(),
      )}
    >
      <Stack>
        <Text size="sm">{messages.sectionHelp}</Text>
        <fieldset disabled={isLocked} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <Stack>
            <Select
              label={messages.sectionAction}
              data={actions}
              allowDeselect={false}
              key={form.key("action")}
              {...form.getInputProps("action")}
            />
            {needsId && (
              <Select
                label={messages.section}
                data={options}
                key={form.key("id")}
                {...form.getInputProps("id")}
              />
            )}
            {needsName && (
              <TextInput
                label={messages.sectionName}
                required
                key={form.key("name")}
                {...form.getInputProps("name")}
              />
            )}
            {isMove && (
              <Select
                label={messages.sectionBefore}
                placeholder={messages.last}
                data={beforeOptions}
                clearable
                key={form.key("before")}
                {...form.getInputProps("before")}
              />
            )}
          </Stack>
        </fieldset>
        <MutationFeedback {...mutation} />
        <Group>
          <Button type="submit" loading={mutation.pending}>
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
