import { useState, type ReactElement } from "react";
import {
  Accordion,
  Alert,
  Button,
  Fieldset,
  Group,
  Modal,
  MultiSelect,
  Select,
  Stack,
  TagsInput,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { PLAN_SCOPE_KINDS } from "@relay/contracts";
import { planContentCommand } from "domains/planning";
import {
  entityName,
  errorMessage,
  useCommandDraft,
  useDraft,
  useEntityPages,
} from "domains/project";
import { MarkdownField } from "ui/markdown-field";
import type {
  PlanFormProps,
  PlanFormValues,
  PlanningDraft,
  ScopeKind,
} from "../../planning-form.types";
import { planningMessages as m } from "../../planning.messages";

/**
 * Редактирует содержание плана на исходной версии без перезаписи черновика событиями SSE.
 *
 * Используется для:
 *  - создания плана и выбора его предметной области
 *  - изменения цели, границ, участников и ожидаемого результата
 */
export function PlanForm({ source, onClose }: PlanFormProps): ReactElement {
  const name = `plan-form:${source?.entity.id ?? "new"}`;
  const draft = useDraft<PlanningDraft<PlanFormValues>>(name, {
    source,
    values: source?.entity.data ?? {
      title: "",
      summary: "",
      goal: "",
      rationale: "",
      boundaries: "",
      expectedResult: "",
      participants: [],
      scope: [],
    },
  });
  const command = useCommandDraft(name);
  const [kind, setKind] = useState<ScopeKind>("feature");
  const [query, setQuery] = useState("");
  const choices = useEntityPages(kind, query.trim() === "" ? {} : { q: query });
  const form = useForm<PlanFormValues>({
    mode: "uncontrolled",
    initialValues: draft.value.values,
    validateInputOnBlur: true,
    validate: { title: (value) => (value.trim() === "" ? m.required : null) },
    onValuesChange: (values) => draft.setValue({ ...draft.value, values }),
  });
  const scope = form.useWatchValue("scope");
  const selected = scope.filter((entry) => entry.kind === kind);
  const options = new Map(
    choices.items.map((entry) => [
      entry.id,
      { value: entry.id, label: `${entry.key} · ${entityName(entry)}` },
    ]),
  );
  for (const entry of selected) {
    if (!options.has(entry.id)) {
      options.set(entry.id, { value: entry.id, label: entry.id });
    }
  }
  const title = source === undefined ? m.newPlan : m.edit;
  const submitLabel = command.uncertain ? m.retry : m.save;
  const isLocked = command.pending || command.uncertain;
  /**
   * Сбрасывает сохранённый черновик только после подтверждённой записи.
   */
  async function save(values: PlanFormValues): Promise<void> {
    const result = await command.submit(planContentCommand(values, draft.value.source));
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
              <Textarea
                label={m.summary}
                autosize
                minRows={2}
                key={form.key("summary")}
                {...form.getInputProps("summary")}
              />
              <MarkdownField
                label={m.goal}
                key={form.key("goal")}
                {...form.getInputProps("goal")}
                disabled={isLocked}
              />
              <TagsInput
                label={m.participants}
                key={form.key("participants")}
                {...form.getInputProps("participants")}
              />
              <Accordion variant="separated">
                <Accordion.Item value="details">
                  <Accordion.Control>{m.boundaries}</Accordion.Control>
                  <Accordion.Panel>
                    <Stack>
                      <MarkdownField
                        label={m.rationale}
                        key={form.key("rationale")}
                        {...form.getInputProps("rationale")}
                        disabled={isLocked}
                      />
                      <MarkdownField
                        label={m.boundaries}
                        key={form.key("boundaries")}
                        {...form.getInputProps("boundaries")}
                        disabled={isLocked}
                      />
                      <MarkdownField
                        label={m.expectedResult}
                        key={form.key("expectedResult")}
                        {...form.getInputProps("expectedResult")}
                        disabled={isLocked}
                      />
                    </Stack>
                  </Accordion.Panel>
                </Accordion.Item>
              </Accordion>
              <Select
                label={m.scopeKind}
                value={kind}
                allowDeselect={false}
                data={PLAN_SCOPE_KINDS.map((value) => ({ value, label: m.scopeKinds[value] }))}
                onChange={(value) => {
                  const next = PLAN_SCOPE_KINDS.find((entry) => entry === value);
                  if (next !== undefined) {
                    setKind(next);
                    setQuery("");
                  }
                }}
              />
              <MultiSelect
                label={m.scope}
                searchable
                searchValue={query}
                onSearchChange={setQuery}
                data={[...options.values()]}
                value={selected.map((entry) => entry.id)}
                onChange={(ids) =>
                  form.setFieldValue("scope", [
                    ...scope.filter((entry) => entry.kind !== kind),
                    ...ids.map((id) => ({ id, kind })),
                  ])
                }
              />
              {choices.error !== undefined && (
                <Alert color="red">{errorMessage(choices.error)}</Alert>
              )}
              {choices.hasMore && (
                <Button variant="subtle" onClick={choices.loadMore}>
                  {m.more}
                </Button>
              )}
            </Stack>
          </Fieldset>
          {command.error !== undefined && (
            <Alert color="red" title={m.failure}>
              {command.error}
            </Alert>
          )}
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
