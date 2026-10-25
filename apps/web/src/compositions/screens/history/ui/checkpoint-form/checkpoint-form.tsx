import { useState, type ReactElement } from "react";
import {
  Accordion,
  Alert,
  Button,
  Fieldset,
  Group,
  Modal,
  MultiSelect,
  Stack,
  TextInput,
  Textarea,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { checkpointCommand } from "domains/history";
import { entityName, errorMessage, useCommandDraft, useDraft, useRead } from "domains/project";
import { MarkdownField } from "ui/markdown-field";
import type {
  CheckpointDraft,
  CheckpointFormProps,
  CheckpointValues,
} from "../../history-form.types";
import { historyMessages as m } from "../../history.messages";

/**
 * Добавляет материал истории с реальными ссылками и приёмкой дочерних результатов.
 *
 * Используется для:
 *  - открытия намерения и сохранения прогресса
 *  - завершения либо отмены намерения отдельным неизменяемым материалом
 */
export function CheckpointForm({
  source,
  action,
  intent,
  children,
  opened,
  onClose,
  onOpen,
  onComplete,
}: CheckpointFormProps): ReactElement {
  const name = `checkpoint-form:${source.entity.id}:${action}:${intent?.id ?? "new"}`;
  const draft = useDraft<CheckpointDraft>(name, {
    source,
    action,
    intent,
    values: {
      title: "",
      body: "",
      summary: "",
      done: "",
      remaining: "",
      nextStep: "",
      checks: "",
      references: [],
      acceptedSessionIds: [],
    },
  });
  const command = useCommandDraft(name);
  const [query, setQuery] = useState("");
  const references = useRead(
    "search",
    !opened || query.trim() === "" ? undefined : { query: { q: query } },
  );
  const form = useForm<CheckpointValues>({
    mode: "uncontrolled",
    initialValues: draft.value.values,
    validateInputOnBlur: true,
    validate: {
      title: (v) => (v.trim() === "" ? m.required : null),
      body: (v) => (v.trim() === "" ? m.required : null),
    },
    onValuesChange: (values) => draft.setValue({ ...draft.value, values }),
  });
  const selected = form.useWatchValue("references");
  const options = new Map(
    (references.data ?? []).map((entry) => [
      entry.id,
      { value: entry.id, label: `${entry.key} · ${entityName(entry)}` },
    ]),
  );
  for (const id of selected) {
    if (!options.has(id)) {
      options.set(id, { value: id, label: id });
    }
  }
  const acceptable = children.filter(
    (child) =>
      child.data.status === "completed" && child.data.originCheckpointId === draft.value.intent?.id,
  );
  const isContinuation = action !== "open";
  const isLocked = command.pending || command.uncertain;
  const labels = {
    open: m.openIntent,
    save: m.saveProgress,
    complete: m.completeIntent,
    cancel: m.cancelIntent,
  };
  const title = labels[action];
  const submitLabel = command.uncertain ? m.retry : m.save;
  /**
   * Удаляет input и экранный выбор именно исходного материала после подтверждённой записи.
   */
  function complete(): void {
    draft.reset();
    onComplete();
  }
  /**
   * Получает сохранённую квитанцию даже после закрытия исходного намерения по SSE.
   */
  async function recover(): Promise<void> {
    if ((await command.recover()) !== undefined) {
      complete();
    }
  }
  /**
   * Передаёт непустые необязательные тексты и сохраняет исходный run вместе с CAS сессии.
   */
  async function save(values: CheckpointValues): Promise<void> {
    const original = draft.value;
    const runId = original.source.entity.data.currentRunId;
    if (runId === null) {
      return;
    }
    const input = {
      runId,
      title: values.title,
      body: values.body,
      references: values.references,
      ...(values.summary.trim() === "" ? {} : { summary: values.summary }),
      ...(values.done.trim() === "" ? {} : { done: values.done }),
      ...(values.remaining.trim() === "" ? {} : { remaining: values.remaining }),
      ...(values.nextStep.trim() === "" ? {} : { nextStep: values.nextStep }),
      ...(values.checks.trim() === "" ? {} : { checks: values.checks }),
      ...(original.action === "open" ? {} : { acceptedSessionIds: values.acceptedSessionIds }),
    };
    if (
      (await command.submit(
        checkpointCommand(original.source, original.action, original.intent?.id, input),
      )) !== undefined
    ) {
      complete();
    }
  }
  if (!opened) {
    return (
      <Alert title={m.savedOperation} color="orange">
        <Stack gap="sm">
          <span>{title}</span>
          {command.error !== undefined && <span>{command.error}</span>}
          <Group>
            <Button variant="default" onClick={onOpen}>
              {m.reopen}
            </Button>
            {command.uncertain && (
              <Button loading={command.pending} onClick={() => void recover()}>
                {m.recover}
              </Button>
            )}
          </Group>
        </Stack>
      </Alert>
    );
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
              <MarkdownField
                label={m.body}
                key={form.key("body")}
                {...form.getInputProps("body")}
                disabled={isLocked}
              />
              <Textarea
                label={m.summary}
                autosize
                key={form.key("summary")}
                {...form.getInputProps("summary")}
              />
              <MultiSelect
                label={m.references}
                description={m.referenceSearch}
                searchable
                searchValue={query}
                onSearchChange={setQuery}
                data={[...options.values()]}
                key={form.key("references")}
                {...form.getInputProps("references")}
              />
              {references.error !== undefined && (
                <Alert color="red">{errorMessage(references.error)}</Alert>
              )}
              {isContinuation && (
                <MultiSelect
                  label={m.accepted}
                  data={acceptable.map((child) => ({ value: child.id, label: child.data.title }))}
                  key={form.key("acceptedSessionIds")}
                  {...form.getInputProps("acceptedSessionIds")}
                />
              )}
              <Accordion variant="separated">
                <Accordion.Item value="continuation">
                  <Accordion.Control>{m.context}</Accordion.Control>
                  <Accordion.Panel>
                    <Stack>
                      <MarkdownField
                        label={m.done}
                        key={form.key("done")}
                        {...form.getInputProps("done")}
                        disabled={isLocked}
                      />
                      <MarkdownField
                        label={m.remaining}
                        key={form.key("remaining")}
                        {...form.getInputProps("remaining")}
                        disabled={isLocked}
                      />
                      <MarkdownField
                        label={m.nextStep}
                        key={form.key("nextStep")}
                        {...form.getInputProps("nextStep")}
                        disabled={isLocked}
                      />
                      <MarkdownField
                        label={m.checks}
                        key={form.key("checks")}
                        {...form.getInputProps("checks")}
                        disabled={isLocked}
                      />
                    </Stack>
                  </Accordion.Panel>
                </Accordion.Item>
              </Accordion>
            </Stack>
          </Fieldset>
          {command.error !== undefined && (
            <Alert color="red" title={m.failure}>
              {command.error}
            </Alert>
          )}
          {command.uncertain && <Alert color="orange">{m.uncertain}</Alert>}
          <Group justify="space-between">
            <Button
              variant="subtle"
              disabled={isLocked}
              onClick={() => {
                command.reset();
                complete();
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
              {command.uncertain && (
                <Button variant="default" loading={command.pending} onClick={() => void recover()}>
                  {m.recover}
                </Button>
              )}
            </Group>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
