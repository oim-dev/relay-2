import { useState, type ReactElement } from "react";
import { Alert, Button, Fieldset, Group, Modal, Select, Stack, Textarea } from "@mantine/core";
import { useForm } from "@mantine/form";
import { planMembershipCommand, type PlanMembershipSource } from "domains/planning";
import {
  entityName,
  errorMessage,
  useCommandDraft,
  useDraft,
  useEntity,
  useEntityPages,
  useRead,
} from "domains/project";
import type {
  MembershipFormProps,
  MembershipValues,
  PlanningDraft,
} from "../../planning-form.types";
import { planningMessages as m } from "../../planning.messages";

/**
 * Меняет одно включение задачи и фиксирует обе версии при атомарном переносе.
 *
 * Используется для:
 *  - добавления и исключения задачи из этапа
 *  - переноса между этапами и планами с обязательным обоснованием
 */
export function MembershipForm({ source, onClose }: MembershipFormProps): ReactElement {
  const name = `membership:${source.entity.id}:${source.stage.id}`;
  const draft = useDraft<PlanningDraft<MembershipValues, PlanMembershipSource>>(name, {
    source,
    values: {
      action: "add",
      task: "",
      targetPlan: "",
      targetStage: "",
      reason: "",
      targetSource: undefined,
    },
  });
  const command = useCommandDraft(name);
  const [query, setQuery] = useState("");
  const tasks = useEntityPages("task", query.trim() === "" ? {} : { q: query });
  const plans = useEntityPages("work-plan");
  const form = useForm<MembershipValues>({
    mode: "uncontrolled",
    initialValues: draft.value.values,
    validateInputOnBlur: true,
    validate: { task: (v) => (!v ? m.required : null) },
    onValuesChange: (values) => draft.setValue({ ...draft.value, values }),
  });
  const action = form.useWatchValue("action");
  const selectedTask = form.useWatchValue("task");
  const targetId = form.useWatchValue("targetPlan");
  const targetStage = form.useWatchValue("targetStage");
  const target = useEntity(targetId || undefined);
  const isTransfer = action === "transfer";
  const isLocked = command.pending || command.uncertain;
  const original = draft.value.source;
  const members = useRead(
    "planStageTasks",
    action === "add" ? undefined : { ref: original.entity.id, stageId: original.stage.id },
  );
  const availableTasks = action === "add" ? tasks.items : (members.data?.items ?? []);
  const options = new Map(
    availableTasks.map((task) => [
      task.id,
      { value: task.id, label: `${task.key} · ${entityName(task)}` },
    ]),
  );
  if (action !== "add") {
    for (const id of original.stage.taskIds) {
      if (!options.has(id)) {
        options.set(id, { value: id, label: id });
      }
    }
  }
  if (selectedTask !== "" && !options.has(selectedTask)) {
    options.set(selectedTask, { value: selectedTask, label: selectedTask });
  }
  const targetRecord = target.data?.entity;
  const stageOptions =
    targetRecord?.kind === "work-plan"
      ? targetRecord.data.stages.map((stage) => ({ value: stage.id, label: stage.title }))
      : [];
  const submitLabel = command.uncertain ? m.retry : m.save;
  /**
   * Использует исходный план и снимок назначения, выбранный пользователем до отправки.
   */
  async function save(values: MembershipValues): Promise<void> {
    let request;
    if (values.action === "transfer") {
      if (
        values.targetSource === undefined ||
        values.targetStage === "" ||
        values.reason.trim() === ""
      ) {
        form.setFieldError("reason", m.required);
        return;
      }
      request = planMembershipCommand(original, {
        action: "transfer",
        task: values.task,
        target: values.targetSource,
        targetStage: values.targetStage,
        reason: values.reason,
      });
    } else {
      request = planMembershipCommand(original, {
        action: values.action,
        task: values.task,
      });
    }
    if ((await command.submit(request)) !== undefined) {
      draft.reset();
      onClose();
    }
  }
  return (
    <Modal
      opened
      title={m.tasks}
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
              <Select
                label={m.action}
                allowDeselect={false}
                data={[
                  { value: "add", label: m.addTask },
                  { value: "remove", label: m.removeTask },
                  { value: "transfer", label: m.transfer },
                ]}
                key={form.key("action")}
                {...form.getInputProps("action")}
              />
              <Select
                label={m.task}
                required
                searchable
                searchValue={query}
                onSearchChange={setQuery}
                data={[...options.values()]}
                key={form.key("task")}
                {...form.getInputProps("task")}
              />
              {tasks.hasMore && (
                <Button variant="subtle" onClick={tasks.loadMore}>
                  {m.more}
                </Button>
              )}
              {tasks.error !== undefined && <Alert color="red">{errorMessage(tasks.error)}</Alert>}
              {members.error !== undefined && (
                <Alert color="red">{errorMessage(members.error)}</Alert>
              )}
              {isTransfer && (
                <>
                  <Select
                    label={m.targetPlan}
                    searchable
                    data={plans.items.map((plan) => ({
                      value: plan.id,
                      label: `${plan.key} · ${entityName(plan)}`,
                    }))}
                    value={targetId || null}
                    onChange={(value) => {
                      form.setFieldValue("targetPlan", value ?? "");
                      form.setFieldValue("targetStage", "");
                      form.setFieldValue("targetSource", undefined);
                    }}
                  />
                  {plans.hasMore && (
                    <Button variant="subtle" onClick={plans.loadMore}>
                      {m.more}
                    </Button>
                  )}
                  {plans.error !== undefined && (
                    <Alert color="red">{errorMessage(plans.error)}</Alert>
                  )}
                  {target.error !== undefined && (
                    <Alert color="red">{errorMessage(target.error)}</Alert>
                  )}
                  <Select
                    label={m.targetStage}
                    data={stageOptions}
                    value={targetStage || null}
                    onChange={(value) => {
                      if (targetRecord?.kind === "work-plan") {
                        form.setFieldValue("targetStage", value ?? "");
                        form.setFieldValue("targetSource", {
                          entity: targetRecord,
                          ...(target.data?.expectedVersion === undefined
                            ? {}
                            : { expectedVersion: target.data.expectedVersion }),
                        });
                      }
                    }}
                  />
                  <Textarea
                    label={m.reason}
                    required
                    autosize
                    key={form.key("reason")}
                    {...form.getInputProps("reason")}
                  />
                </>
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
                draft.reset();
                command.reset();
                onClose();
              }}
            >
              {m.discard}
            </Button>
            <Button type="submit" loading={command.pending}>
              {submitLabel}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
