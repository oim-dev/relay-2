import type { ReactElement } from "react";
import { Alert, Button, Fieldset, Group, Modal, Select, Stack } from "@mantine/core";
import { useForm } from "@mantine/form";
import { planTransitionCommand, releaseTransitionCommand } from "domains/planning";
import { useCommandDraft, useDraft } from "domains/project";
import { MarkdownField } from "ui/markdown-field";
import type { PlanningTransitionProps } from "../../planning-form.types";
import { planningMessages as m } from "../../planning.messages";

/**
 * Подтверждает явный переход планирования с сохранённой исходной версией.
 *
 * Используется для:
 *  - начала, завершения и отмены плана с итоговым текстом
 *  - публикации, отмены и перепланирования релиза
 */
export function PlanningTransition({
  source,
  opened,
  onClose,
  onOpen,
  onComplete,
}: PlanningTransitionProps): ReactElement {
  const name = `planning-transition:${source.entity.id}`;
  const draft = useDraft(name, { source, values: { action: "", result: "" } });
  const command = useCommandDraft(name);
  const form = useForm({
    mode: "uncontrolled",
    initialValues: draft.value.values,
    validateInputOnBlur: true,
    validate: { action: (value) => (!value ? m.required : null) },
    onValuesChange: (values) => draft.setValue({ ...draft.value, values }),
  });
  const isPlan = draft.value.source.entity.kind === "work-plan";
  const status = draft.value.source.entity.data.status;
  const options = isPlan
    ? [
        ...(status === "draft" ? [{ value: "start", label: m.start }] : []),
        { value: "complete", label: m.complete },
        { value: "cancel", label: m.cancel },
      ]
    : [
        ...(status === "planned"
          ? [
              { value: "publish", label: m.publish },
              { value: "cancel", label: m.cancel },
            ]
          : []),
        ...(status === "cancelled" ? [{ value: "plan", label: m.replan }] : []),
      ];
  const action = form.useWatchValue("action");
  const needsResult = isPlan && (action === "complete" || action === "cancel");
  const isLocked = command.pending || command.uncertain;
  const submitLabel = command.uncertain ? m.retry : m.save;
  /**
   * Очищает исходный input draft и его экранный выбор после достоверного исхода.
   */
  function complete(): void {
    draft.reset();
    onComplete();
  }
  /**
   * Читает первоначальную квитанцию без POST и без подмены guards свежим статусом.
   */
  async function recover(): Promise<void> {
    if ((await command.recover()) !== undefined) {
      complete();
    }
  }
  /**
   * Core проверяет переход и готовность в момент записи; отказ не меняет исходные guards.
   */
  async function save(values: typeof draft.value.values): Promise<void> {
    if (needsResult && values.result.trim() === "") {
      form.setFieldError("result", m.required);
      return;
    }
    let request;
    if (isPlan) {
      if (values.action !== "start" && values.action !== "complete" && values.action !== "cancel") {
        return;
      }
      request = planTransitionCommand(
        draft.value.source,
        values.action === "start"
          ? { action: "start" }
          : { action: values.action, result: values.result },
      );
    } else {
      if (values.action !== "plan" && values.action !== "publish" && values.action !== "cancel") {
        return;
      }
      request = releaseTransitionCommand(draft.value.source, values.action);
    }
    if ((await command.submit(request)) !== undefined) {
      complete();
    }
  }
  if (!opened) {
    return (
      <Alert title={m.savedTransition} color="orange">
        <Stack gap="sm">
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
      title={m.changeStatus}
      onClose={onClose}
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
              <Select
                label={m.action}
                data={options}
                required
                key={form.key("action")}
                {...form.getInputProps("action")}
              />
              {needsResult && (
                <MarkdownField
                  label={m.result}
                  key={form.key("result")}
                  {...form.getInputProps("result")}
                  disabled={isLocked}
                />
              )}
            </Stack>
          </Fieldset>
          {command.error !== undefined && <Alert color="red">{command.error}</Alert>}
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
            <Button type="submit" loading={command.pending}>
              {submitLabel}
            </Button>
            {command.uncertain && (
              <Button variant="default" loading={command.pending} onClick={() => void recover()}>
                {m.recover}
              </Button>
            )}
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
