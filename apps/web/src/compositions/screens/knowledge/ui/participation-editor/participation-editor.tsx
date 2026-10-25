import type { ReactElement } from "react";
import { Button, Group, Stack, Switch, Text } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useCommandDraft, useDraft } from "domains/project";
import { MutationFeedback, participationCommand } from "domains/knowledge";
import type {
  ParticipationDraft,
  ParticipationEditorProps,
} from "./types/participation-editor-props.type";
import { messages } from "../../config/knowledge-screen.messages";

/**
 * Меняет реальный active через атомарную замену участия приложения.
 *
 * Используется для:
 *  - снятия и восстановления участия без потери остальных реализаций
 */
export const ParticipationEditor = (props: ParticipationEditorProps): ReactElement => {
  const scope = `participation:${props.implementationId}`;
  const targets =
    props.owner.entity.kind === "application" ? props.owner.entity.data.implementationIds : [];
  const draft = useDraft<ParticipationDraft>(scope, {
    owner: props.owner,
    active: targets.includes(props.implementationId),
  });
  const mutation = useCommandDraft(scope);
  const form = useForm({
    mode: "uncontrolled",
    initialValues: { active: draft.value.active },
    onValuesChange: (values) => draft.setValue({ ...draft.value, active: values.active }),
  });
  const isLocked = mutation.uncertain || form.submitting;
  const saveLabel = mutation.uncertain ? messages.repeat : messages.save;

  /**
   * Сохраняет полный первоначальный состав, меняя только выбранного участника.
   */
  async function save(values: { active: boolean }): Promise<void> {
    const result = await mutation.submit(
      participationCommand(draft.value.owner, props.implementationId, values.active),
    );
    if (result !== undefined) {
      draft.reset();
      props.onSaved();
    }
  }
  return (
    <form onSubmit={form.onSubmit(save)}>
      <Stack>
        <Text size="sm">{messages.participationHelp}</Text>
        <Switch
          label={messages.active}
          key={form.key("active")}
          {...form.getInputProps("active", { type: "checkbox" })}
          disabled={isLocked}
        />
        <MutationFeedback {...mutation} />
        <Group>
          <Button type="submit" loading={mutation.pending}>
            {saveLabel}
          </Button>
          <Button variant="default" onClick={props.onClose}>
            {messages.close}
          </Button>
          <Button
            variant="subtle"
            color="red"
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
