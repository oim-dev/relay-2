import type { ReactElement } from "react";
import { Alert, Button, Fieldset, Group, Modal, Stack, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { sessionCommand, type SessionChange } from "domains/history";
import { useCommandDraft, useDraft } from "domains/project";
import { MarkdownField } from "ui/markdown-field";
import type { SessionFormProps, SessionValues } from "../../history-form.types";
import { historyMessages as m } from "../../history.messages";

/**
 * Создаёт сессию либо фиксирует выбранный переход на исходной ревизии.
 *
 * Используется для:
 *  - начала работы и дочернего поручения из намерения
 *  - передачи ответственности, паузы и закрытия сессии
 */
export function SessionForm({
  source,
  action,
  intent,
  opened,
  onClose,
  onOpen,
  onComplete,
}: SessionFormProps): ReactElement {
  const name = `session-form:${source?.entity.id ?? "new"}:${action}:${intent?.id ?? ""}`;
  const draft = useDraft(name, {
    source,
    action,
    intent,
    values: { title: "", description: "", reason: "", result: "" },
  });
  const command = useCommandDraft(name);
  const original = draft.value;
  const isNew = action === "start" || action === "fork";
  const isClosing = action === "complete" || action === "cancel";
  const needsReason = action === "pause" || action === "takeover";
  const isConnection = action === "attach" || action === "resume" || needsReason;
  const isLocked = command.pending || command.uncertain;
  const form = useForm<SessionValues>({
    mode: "uncontrolled",
    initialValues: original.values,
    validateInputOnBlur: true,
    validate: {
      title: (value) => (isNew && value.trim() === "" ? m.required : null),
      reason: (value) => (needsReason && value.trim() === "" ? m.required : null),
      result: (value) => (isClosing && value.trim() === "" ? m.required : null),
    },
    onValuesChange: (values) => draft.setValue({ ...draft.value, values }),
  });
  const label = m[action];
  const submitLabel = command.uncertain ? m.retry : label;
  /**
   * Удаляет те же исходные input и editor после submit или подтверждения receipt.
   */
  function complete(): void {
    draft.reset();
    onComplete();
  }
  /**
   * Проверяет квитанцию исходного действия; отсутствие receipt сохраняет frozen запрос.
   */
  async function recover(): Promise<void> {
    if ((await command.recover()) !== undefined) {
      complete();
    }
  }
  /**
   * Подбирает поля строго по действию; run берётся только из исходной сессии.
   */
  async function save(values: SessionValues): Promise<void> {
    const description = values.description.trim() === "" ? {} : { description: values.description };
    const reason = values.reason.trim() === "" ? {} : { reason: values.reason };
    const runId = original.source?.entity.data.currentRunId;
    let change: SessionChange;
    switch (original.action) {
      case "start":
        change = { action: "start", title: values.title, ...description };
        break;
      case "fork":
        if (runId == null || original.intent === undefined) {
          return;
        }
        change = {
          action: "fork",
          title: values.title,
          ...description,
          runId,
          intent: original.intent,
        };
        break;
      case "pause":
        if (runId == null) {
          return;
        }
        change = { action: "pause", reason: values.reason, runId };
        break;
      case "complete":
      case "cancel":
        change = {
          action: original.action,
          result: values.result,
          ...(runId == null ? {} : { runId }),
        };
        break;
      case "attach":
      case "resume":
        change = { action: original.action, ...reason };
        break;
      case "takeover":
        change = { action: "takeover", reason: values.reason };
        break;
    }
    if ((await command.submit(sessionCommand(change, original.source))) !== undefined) {
      complete();
    }
  }
  if (!opened) {
    return (
      <Alert title={m.savedOperation} color="orange">
        <Stack gap="sm">
          <span>{label}</span>
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
      title={label}
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
              {isNew && (
                <>
                  <TextInput
                    label={m.title}
                    required
                    data-autofocus
                    key={form.key("title")}
                    {...form.getInputProps("title")}
                  />
                  <MarkdownField
                    label={m.description}
                    key={form.key("description")}
                    {...form.getInputProps("description")}
                    disabled={isLocked}
                  />
                </>
              )}
              {isConnection && (
                <MarkdownField
                  label={m.reason}
                  key={form.key("reason")}
                  {...form.getInputProps("reason")}
                  disabled={isLocked}
                />
              )}
              {isClosing && (
                <MarkdownField
                  label={m.result}
                  key={form.key("result")}
                  {...form.getInputProps("result")}
                  disabled={isLocked}
                />
              )}
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
