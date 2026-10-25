import { useState, type ReactElement } from "react";
import {
  Alert,
  Button,
  Fieldset,
  Group,
  Modal,
  MultiSelect,
  Stack,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { releaseContentCommand } from "domains/planning";
import {
  entityName,
  errorMessage,
  useCommandDraft,
  useDraft,
  useEntityPages,
} from "domains/project";
import { MarkdownField } from "ui/markdown-field";
import type { PlanningDraft, ReleaseFormProps, ReleaseFormValues } from "../../planning-form.types";
import { planningMessages as m } from "../../planning.messages";

/**
 * Собирает релиз с реальным составом планов и исходной версией.
 *
 * Используется для:
 *  - создания будущего выпуска и изменения его состава
 *  - ввода описания, версии и плановой даты
 */
export function ReleaseForm({ source, onClose }: ReleaseFormProps): ReactElement {
  const name = `release-form:${source?.entity.id ?? "new"}`;
  const draft = useDraft<PlanningDraft<ReleaseFormValues>>(name, {
    source,
    values: source?.entity.data ?? {
      title: "",
      version: "",
      summary: "",
      description: "",
      plannedFor: "",
      planIds: [],
    },
  });
  const command = useCommandDraft(name);
  const [query, setQuery] = useState("");
  const plans = useEntityPages("work-plan", query.trim() === "" ? {} : { q: query });
  const form = useForm<ReleaseFormValues>({
    mode: "uncontrolled",
    initialValues: draft.value.values,
    validateInputOnBlur: true,
    validate: {
      title: (v) => (v.trim() === "" ? m.required : null),
      version: (v) => (v.trim() === "" ? m.required : null),
      planIds: (v) => (v.some(Boolean) ? null : m.selectPlans),
    },
    onValuesChange: (values) => draft.setValue({ ...draft.value, values }),
  });
  const ids = form.useWatchValue("planIds");
  const options = new Map(
    plans.items.map((plan) => [
      plan.id,
      { value: plan.id, label: `${plan.key} · ${entityName(plan)}` },
    ]),
  );
  for (const id of ids) {
    if (!options.has(id)) {
      options.set(id, { value: id, label: id });
    }
  }
  const title = source === undefined ? m.newRelease : m.edit;
  const submitLabel = command.uncertain ? m.retry : m.save;
  const isLocked = command.pending || command.uncertain;
  /**
   * Отправляет полный состав на исходных guards; после отказа сохраняет пользовательский ввод.
   */
  async function save(values: ReleaseFormValues): Promise<void> {
    const result = await command.submit(releaseContentCommand(values, draft.value.source));
    if (result !== undefined) {
      draft.reset();
      onClose();
    }
  }
  return (
    <Modal
      opened
      title={title}
      onClose={onClose}
      size="xl"
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
              <Group grow>
                <TextInput
                  label={m.version}
                  required
                  key={form.key("version")}
                  {...form.getInputProps("version")}
                />
                <TextInput
                  type="date"
                  label={m.plannedFor}
                  key={form.key("plannedFor")}
                  {...form.getInputProps("plannedFor")}
                />
              </Group>
              <Textarea
                label={m.summary}
                autosize
                minRows={2}
                key={form.key("summary")}
                {...form.getInputProps("summary")}
              />
              <MultiSelect
                label={m.composition}
                required
                searchable
                searchValue={query}
                onSearchChange={setQuery}
                data={[...options.values()]}
                key={form.key("planIds")}
                {...form.getInputProps("planIds")}
              />
              {plans.error !== undefined && <Alert color="red">{errorMessage(plans.error)}</Alert>}
              {plans.hasMore && (
                <Button variant="subtle" onClick={plans.loadMore}>
                  {m.more}
                </Button>
              )}
              <MarkdownField
                label={m.description}
                key={form.key("description")}
                {...form.getInputProps("description")}
                disabled={isLocked}
              />
            </Stack>
          </Fieldset>
          {command.error !== undefined && <Alert color="red">{command.error}</Alert>}
          {command.uncertain && <Alert color="orange">{m.uncertain}</Alert>}
          <Text size="xs" c="dimmed">
            {m.draft}
          </Text>
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
