import {
  Alert,
  Button,
  Fieldset,
  Group,
  Modal,
  Paper,
  Select,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { useState, type ReactElement } from "react";
import { useNavigate } from "react-router-dom";
import { useCommandDraft, useDraft, useProject, useRead } from "domains/project";
import {
  CommandFeedback,
  EntityReference,
  ReferencePicker,
  TaskCreateForm,
  TASK_RELATION_ACTIONS,
  changeTaskRelationCommand,
  type TaskRelationInput,
  taskMessages,
} from "domains/tasks";
import {
  taskScreenMessages as messages,
  taskRelationLabels,
} from "../../config/task-screen.messages";
import type {
  RelationDraft,
  RelationValues,
  TaskSectionProps,
} from "../../types/task-editor.types";

/**
 * Показывает родителя, детей, зависимости и цели задачи.
 *
 * Используется для:
 *  - переходов по постоянным ID и изменения одной связи отдельным действием
 *  - создания прямой подзадачи на текущей доске
 */
export const TaskRelations = ({ snapshot }: TaskSectionProps): ReactElement => {
  const name = `task-relations:${snapshot.task.id}`;
  const { projectId } = useProject();
  const navigate = useNavigate();
  const children = useRead("taskChildren", { ref: snapshot.task.id });
  const draft = useDraft<RelationDraft | null>(name, null);
  const action = useCommandDraft(name);
  const [isCreating, setCreating] = useState(false);
  const initial: RelationValues = { action: "dependency.add", target: "", targetKind: "feature" };
  const form = useForm<RelationValues>({
    mode: "uncontrolled",
    initialValues: draft.value?.values ?? initial,
    onValuesChange: (values) => {
      if (draft.value !== null) {
        draft.setValue({ ...draft.value, values });
      }
    },
  });
  const selectedAction = form.useWatchValue("action");
  const targetKind = form.useWatchValue("targetKind");
  const isTargetAction = selectedAction === "target.add" || selectedAction === "target.remove";
  const hasTargetField = selectedAction !== "parent.clear";
  const selectedKind =
    targetKind === "scenario" || targetKind === "implementation" ? targetKind : "feature";
  const referenceKind = isTargetAction ? selectedKind : "task";
  const isLocked = action.pending || action.uncertain;
  const submitLabel = action.uncertain ? taskMessages.retry : messages.save;
  const parentId = snapshot.task.data.parentId;
  const childItems = children.data ?? [];
  const groups = [
    { label: messages.dependencies, ids: snapshot.task.data.dependencies },
    { label: messages.related, ids: snapshot.task.data.related },
    { label: messages.targets, ids: snapshot.task.data.targets },
  ];
  const actionItems = TASK_RELATION_ACTIONS.map((value) => ({
    value,
    label: taskRelationLabels[value],
  }));

  /**
   * Проверяет наличие выбранного ID и отправляет только параметры конкретного действия.
   */
  async function submit(values: RelationValues): Promise<void> {
    if (draft.value === null) {
      return;
    }
    if (values.action !== "parent.clear" && values.target === "") {
      form.setFieldError("target", messages.targetRequired);
      return;
    }
    const input: TaskRelationInput =
      values.action === "parent.clear"
        ? { action: values.action }
        : { action: values.action, targetId: values.target };
    const command = changeTaskRelationCommand(draft.value.snapshot, input);
    if ((await action.submit(command)) !== undefined) {
      draft.setValue(null);
    }
  }

  return (
    <Paper withBorder p="md">
      <Stack>
        <Title order={2} size="h4">
          {messages.relations}
        </Title>
        <Text fw={600} size="sm">
          {messages.parent}
        </Text>
        {parentId !== null && <EntityReference id={parentId} />}
        <Text fw={600} size="sm">
          {messages.children}
        </Text>
        {children.error !== undefined && (
          <Alert color="orange" title={messages.projectionError}>
            <Button variant="subtle" onClick={() => void children.mutate()}>
              {messages.reload}
            </Button>
          </Alert>
        )}
        {childItems.map((child) => (
          <EntityReference key={child.id} id={child.id} />
        ))}
        <Button variant="subtle" size="xs" onClick={() => setCreating(true)}>
          {taskMessages.createChild}
        </Button>
        {groups.map((group) => (
          <Stack gap="xs" key={group.label}>
            <Text fw={600} size="sm">
              {group.label}
            </Text>
            {group.ids.map((id) => (
              <EntityReference key={id} id={id} />
            ))}
          </Stack>
        ))}
        {draft.value === null && (
          <Button
            variant="light"
            onClick={() => {
              draft.setValue({ snapshot, values: initial });
              form.setValues(initial);
              action.reset();
            }}
          >
            {messages.relationChange}
          </Button>
        )}
        {draft.value !== null && (
          <form onSubmit={form.onSubmit(submit)}>
            <Stack>
              <Fieldset variant="unstyled" disabled={isLocked}>
                <Stack>
                  <Select
                    key={form.key("action")}
                    label={messages.relationAction}
                    allowDeselect={false}
                    data={actionItems}
                    {...form.getInputProps("action")}
                  />
                  {isTargetAction && (
                    <Select
                      key={form.key("targetKind")}
                      label={messages.targetKind}
                      allowDeselect={false}
                      data={[
                        { value: "feature", label: messages.feature },
                        { value: "scenario", label: messages.scenario },
                        { value: "implementation", label: messages.implementation },
                      ]}
                      {...form.getInputProps("targetKind")}
                    />
                  )}
                  {hasTargetField && (
                    <ReferencePicker
                      key={`${referenceKind}:${form.key("target")}`}
                      kind={referenceKind}
                      label={messages.relationTarget}
                      disabled={isLocked}
                      {...form.getInputProps("target")}
                    />
                  )}
                </Stack>
              </Fieldset>
              <CommandFeedback action={action} />
              <Group>
                <Button type="submit" loading={action.pending}>
                  {submitLabel}
                </Button>
                <Button
                  variant="subtle"
                  disabled={isLocked}
                  onClick={() => {
                    draft.setValue(null);
                    action.reset();
                  }}
                >
                  {messages.cancel}
                </Button>
              </Group>
            </Stack>
          </form>
        )}
        <Modal
          opened={isCreating}
          onClose={() => setCreating(false)}
          title={taskMessages.createChild}
          size="lg"
        >
          <TaskCreateForm
            boardId={snapshot.task.data.boardId}
            parentId={snapshot.task.id}
            onCreated={(id) => {
              setCreating(false);
              navigate(
                `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(id)}`,
              );
            }}
          />
        </Modal>
      </Stack>
    </Paper>
  );
};
